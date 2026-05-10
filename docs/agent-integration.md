# Agent 框架接入文档

面向**在本仓内开发**的人。回答"我想加 X，应该改哪"。不重复 [`architecture.md`](./architecture.md)（架构总览）和 [`agent-core-usage.md`](./agent-core-usage.md)（agent-core 单层 API 详解），看完本文如果还想深挖某层，跳那两篇。

## 1. 框架是什么

```
┌─ src/agent-core/ ────────────────────────────────────────────┐
│  平台无关的引擎：LLM 循环、工具协议、Skill 协议、注册表       │
│  零 chrome.*、零 IDB、零 vite。CLI / Bun / 浏览器 都能用      │
└──────────────────────────────────────────────────────────────┘
                        ▲ 被以下三层使用
            ┌───────────┼────────────────────┐
            │           │                    │
┌─ src/extension-tools/ ─┐  ┌─ src/extension-skills/ ─┐
│  浏览器特化工具：       │  │  bundled .md skills：    │
│  readPage、tabs、      │  │  vite glob 加载，        │
│  screenshot 等          │  │  唯一 Vite 边界         │
└────────────────────────┘  └──────────────────────────┘
                        ▲ 都被以下层装配
                        │
┌─ src/extension/ ─────────────────────────────────────────────┐
│  Chrome MV3 装配 + RPC + 持久化：                             │
│   • offscreen.ts  ← agent loop 跑在这里                       │
│   • agentService.ts  ← deps 注入，可单测的编排层              │
│   • rpc/hub.ts、rpc/client.ts  ← 跨上下文 port + 事件路由     │
│   • agent-client/  ← createAgentClient() SDK，给 in-extension │
│                       的非聊天 consumer 用                    │
│   • storage/  ← IndexedDB + chrome.storage 包装               │
└──────────────────────────────────────────────────────────────┘
```

外部还有 `scripts/agent-repl.ts`：纯 Bun 跑的 CLI，把 agent-core + tools + skills 用 fs loader 串起来，作为 demo / 调试入口。

## 2. 决策树：你想做什么？

| 想做什么 | 改哪 | 工作量 | 详见 |
|---|---|---|---|
| 加一个新工具（例如 `getWeather`） | `src/extension-tools/tools/<name>.ts` + `index.ts` | 30 分钟 | §3.1 |
| 加一个新 skill（纯文本指令包） | `src/extension-skills/skills/<name>/SKILL.md` | 5 分钟 | §3.2 |
| 在扩展里某个新地方调 agent（右键菜单 / options 页 / background alarm） | `import { createAgentClient } from '@ext/agent-client'` | 1 小时 | §3.3 |
| 在扩展外（CLI、Bun、Node）单独跑 agent | 直接用 `@core` 的 `createAgent` | 见 [agent-core-usage.md](./agent-core-usage.md) | §3.4 |
| 写一个完全自定义的 agent 后端（不用 chrome.storage / IDB） | `createAgentService(deps)` 注入自己的 deps | 半天 | §3.5 |
| 改 LLM provider（Bedrock / Anthropic Messages API） | **不支持**——有意限定 OpenAI-compatible only | — | — |
| 暴露 HTTP / SSE 给外部进程 | **不支持**（MV3 扩展不能 listen 端口）；要一个伴生进程 | — | — |

## 3. 场景详解

### 3.1 加一个新工具

工具是 LLM 可见的可调用函数。最小接口：

```ts
import type { ToolDefinition } from '@core'
import { makeOk, makeError } from '@core'

export const getWeatherTool: ToolDefinition<
  { city: string },                  // input
  { tempC: number; condition: string }, // output
  any                                 // ExtraCtx（用 any 兼容 ExtensionToolCtx）
> = {
  name: 'getWeather',
  description:
    '获取指定城市的当前天气。Args: { city: string }。' +
    '输入需要城市名（中文或英文都行）。',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  async execute(input, _ctx) {
    if (!input?.city) return makeError('invalid_input', 'city is required')
    try {
      const res = await fetch(`https://wttr.in/${encodeURIComponent(input.city)}?format=j1`)
      if (!res.ok) return makeError('http_error', `wttr returned ${res.status}`, true)
      const data = await res.json()
      return makeOk({
        tempC: Number(data.current_condition[0].temp_C),
        condition: data.current_condition[0].weatherDesc[0].value,
      })
    } catch (e: any) {
      return makeError('network_error', e?.message ?? String(e), true)
    }
  },
}
```

注册：在 `src/extension-tools/index.ts` 的 `extensionTools` 数组里加上。

```ts
// src/extension-tools/index.ts
import { getWeatherTool } from './tools/getWeather'
export const extensionTools = [
  readPageTool, readSelectionTool, querySelectorTool,
  screenshotTool, listTabsTool,
  getWeatherTool,   // ← 加这里
]
```

完事。下次 build 后所有 agent 入口（聊天、REPL、SDK consumer）都能调用。

**契约**：
- `execute` 必须返回 `ToolResult<T> = { ok: true, data } | { ok: false, error }`，**不能 throw**——agent loop 会把 throw 当成 LLM 致命错误，工具应该用 `makeError` 表达可恢复失败。
- `makeError(code, message, retryable=false)`：retryable=true 时 LLM 会更倾向重试。
- 需要浏览器能力（DOM 操作、tabs 等）：通过 `ctx.rpc.domOp(...)` / `ctx.rpc.chromeApi(...)`，offscreen 里已经接好。看 `tools/readPage.ts` 模板。
- 需要当前 tab id：`ctx.tabId`（offscreen 装配层算好的）。

**写测试**（每个工具都该有）：

```ts
// tests/tools/getWeather.test.ts
import { describe, it, expect, vi } from 'vitest'
import { getWeatherTool } from '@ext-tools/tools/getWeather'

describe('getWeather tool', () => {
  it('returns ok with temp and condition', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current_condition: [{ temp_C: '15', weatherDesc: [{ value: '阴' }] }],
      }),
    } as any)
    const result = await getWeatherTool.execute({ city: '上海' }, {} as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.tempC).toBe(15)
  })
})
```

参考样板：`tests/tools/fetchGet.test.ts`、`tests/tools/readPage.test.ts`。

### 3.2 加一个新 skill

Skill 是给 LLM 的"配方"——一段 markdown 指令，LLM 通过 `useSkill(name)` 加载后按里面步骤执行（用现有工具）。

```bash
mkdir -p src/extension-skills/skills/translateSelection
cat > src/extension-skills/skills/translateSelection/SKILL.md <<'EOF'
---
name: translateSelection
description: Translate the user's currently selected text into the target language they specify.
---

# Instructions

1. Call `readSelection` to get the selected text.
2. If the user already specified a target language in their request, use it.
   Otherwise ask once: "翻译成哪种语言？"
3. Translate the selection. Preserve formatting (lists, code blocks, line breaks).
4. Reply with **only** the translated text. No commentary.
EOF
```

可选加参考文档：

```bash
mkdir -p src/extension-skills/skills/translateSelection/references
cat > src/extension-skills/skills/translateSelection/references/style.md <<'EOF'
# 翻译风格

- 中→英：技术内容用平实英语，不要用 marketing 措辞
- 英→中：保留原文专有名词不译（API 名、人名、产品名）
- 代码块内的注释也要翻
EOF
```

`bun run build` 后，新 skill 自动出现在 `useSkill` 的列表里。**零代码改动**。

**约束**：
- 文件夹名 = SKILL.md 的 `name` 字段（不一致 build 时报错）
- frontmatter 必须有 `name` 和 `description`，都是字符串
- skill 文件夹精确一层深（`skills/<name>/`，但内部可以再分子目录）
- 重名 skill build 时报错

完整设计见 [`docs/superpowers/specs/2026-05-10-skills-design.md`](./superpowers/specs/2026-05-10-skills-design.md)。

### 3.3 在扩展里某个新地方调 agent

聊天框只是 agent 的一个 consumer。要在右键菜单、options 页、background alarm、popup 等地方也调 agent，用 **`createAgentClient()` SDK**：

```ts
// 任何 extension context（content / options / popup / background）
import { createAgentClient } from '@ext/agent-client'

// 一次性查询（推荐 for menu / hotkey）
const agent = createAgentClient()
const { text } = await agent.oneShot('解释这段选中的代码', {
  tools: ['readSelection'],   // 限制 LLM 只能用这一个工具
  system: '一句话解释，不超过 30 字',
  ephemeral: true,             // 不污染聊天历史
})
agent.close()
console.log(text)

// 流式订阅（推荐 for 自定义 chat surface）
const agent2 = createAgentClient()
for await (const ev of agent2.message({ text: '你好' })) {
  if (ev.kind === 'message/streamChunk') {
    appendToUi(ev.delta)
  } else if (ev.kind === 'tool/start') {
    showToolBubble(ev.toolCall)
  }
}
agent2.close()
```

**SDK 关键约束**：
- 一个 `AgentClient` = 一个长连 port = 一个 sessionId。**串行**：上一轮 `message()` 的 AsyncIterable 没 drain 完、`oneShot()` 没 resolve 之前不要发下一轮。
- 想并行：建多个 `AgentClient` 实例（每个一个 sessionId）。
- `oneShot()` 默认 `ephemeral: true`，调用方显式传 `ephemeral: false` 才会写聊天历史。
- `cancel()` 中断当前 turn；`close()` 拆线，client 不可再用。

完整 API 在 `src/extension/agent-client/index.ts`，单测在 `tests/agent-client/agentClient.test.ts`。

**新 consumer 的接入清单**：
1. 在你的 extension context（content/options/popup/background）import SDK
2. 决定 streaming（用 `message()`）还是 oneshot（用 `oneShot()`）
3. 决定要不要 `ephemeral`、`tools` 限定、`system` 覆盖
4. 写测试（参考 `tests/agent-client/agentClient.test.ts` 用 `installHub` + 假 offscreen 模拟）

### 3.4 在扩展外用 agent（CLI / Bun / Node）

如果只想 CLI 跑 agent（比如做 eval、批跑、烟雾测试），跳过整个 extension 层，直接用 `@core`。

最简范式：

```ts
import { createAgent, type ChatMessage } from '../src/agent-core'
import { fetchGetTool } from '../src/agent-core/tools/fetchGet'

const agent = createAgent({
  llm: { apiKey: '...', baseUrl: '...', model: '...' },
  tools: [fetchGetTool],
  toolContext: {},
})

const history: ChatMessage[] = []
for await (const ev of agent.send('你好', { history })) {
  if (ev.kind === 'message/streamChunk') process.stdout.write(ev.delta)
}
```

样板看 `scripts/agent-repl.ts`：完整 CLI，含 fs-based skills loader（绕开 vite glob）、彩色输出、slash 命令。直接 `cp` 改改就能起新场景。

详细 API 见 [`agent-core-usage.md`](./agent-core-usage.md)。

### 3.5 写自定义 agent 后端（替换 deps）

如果不想用默认的 chrome.storage / IndexedDB 持久化，自己控制 settings 来源、消息存储、tool 上下文 —— 用 `createAgentService(deps)`：

```ts
import { createAgentService } from '@ext/agentService'

const myService = createAgentService({
  loadSettings: async () => ({
    apiKey: process.env.OPENAI_KEY!,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    /* 其他必填字段见 src/extension/storage/settings.ts */
  } as any),

  emit: (ev) => myEventBus.publish(ev),  // 你怎么把事件出去都行

  // 持久化 deps —— 想自己接 Postgres / KV 都行
  appendMessage: async (msg) => { /* ... */ return { id: '...', createdAt: 0 } },
  listMessagesByConversation: async (cid) => [/* ... */],
  updateMessage: async (id, patch) => { /* ... */ },
  activeConversationId: async () => 'conv-1',

  // 工具上下文 —— 想接 Playwright / 真 fs / 别的运行时都行
  buildToolContext: async (cid) => ({
    rpc: { domOp: myDomDriver, chromeApi: myChromeStub },
    tabId: undefined,
    conversationId: cid,
  }),

  // 可选：自定义 tools 列表（默认 fetchGet + extensionTools + skill 工具）
  // tools: [...]
})

// 然后调用：
await myService.runTurn(
  { sessionId: '...', text: '你好', ephemeral: true },
  (cancel) => { abortRegistry.set('...', cancel) },
)
```

deps 注入意味着：单测里你只需要塞假 deps + 假 createAgent，不用 boot offscreen / chrome / IDB 任何东西。看 `tests/agent/agentService.test.ts` 的 9 个用例。

**用这条路的典型场景**：
- 写 Native Messaging 伴生进程，对外暴露 HTTP/SSE
- 写一个不依赖 chrome 的 desktop app（Electron）复用 agent 逻辑
- 写另一种持久化方案（比如不要 IDB，要 SQLite）

## 4. 类型速查

```ts
// src/agent-core/types.ts
ToolDefinition<I, O, ExtraCtx> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema 子集
  execute: (input: I, ctx: ToolExecContext & ExtraCtx) => Promise<ToolResult<O>>
}

ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean; details?: unknown } }

ToolExecContext = {
  signal?: AbortSignal     // 工具内长操作可以监听这个，被 cancel 时及时返回
}

// agent-core/Skill.ts
SkillDefinition = {
  name: string
  description: string
  body: string                       // SKILL.md 正文
  files: Record<string, string>      // 其他 .md，相对路径为 key
  meta?: Record<string, string>      // 未知 frontmatter 字段
}

// extension/agent-client/index.ts
MessageOptions = {
  text: string
  system?: string                    // 覆盖 system prompt
  tools?: string[]                   // 工具白名单（按 name 过滤）
  model?: string                     // 覆盖 model
  ephemeral?: boolean                // true = 不写 IDB、不读历史
}
```

## 5. 错误处理

### 5.1 工具内部失败

工具不该 throw，要返回 `makeError(code, message, retryable?)`：

```ts
async execute(input, ctx) {
  try {
    return makeOk(await doStuff(input))
  } catch (e: any) {
    return makeError('downstream_error', e.message, true)
  }
}
```

LLM 看到 `{"ok":false,"error":{...}}` 后通常会道歉 / 重试 / 换路。

### 5.2 LLM 致命错误

如果 LLM endpoint 挂了（auth fail、URL 错、超时），agent 会 emit 一个 `fatalError` event：

```ts
for await (const ev of agent.send(...)) {
  if (ev.kind === 'fatalError') {
    console.error(ev.code, ev.message)  // e.g. 'engine_error', 'no_api_key'
  }
}
```

`agentService` 已经在 `runTurn` 顶部对 `no_api_key` 做了短路。

### 5.3 SW / offscreen 运行时错误

任何 `unhandledrejection` / `error` 在 SW 或 offscreen 里被捕获后，会**自动转发**到所有活跃 session port，作为 `runtime/error` event 出现在 content tab 的 F12 console。不需要单独看 SW DevTools。

实现细节：`src/extension/rpc/hub.ts` 的 `broadcastRuntimeError`，content 端在 `ChatApp.tsx` 监听这个事件并 console.error。

## 6. 取消

每个进入中的 turn 都注册了 cancel：

```ts
// 来自 ChatApp / SDK：
clientRef.current.send({ kind: 'chat/cancel' })

// 直接用 agent-core：
const stream = agent.send('...')
setTimeout(() => agent.cancel(), 200)
for await (const ev of stream) { /* 会收到 done with stopReason='cancel' */ }
```

工具执行中的 fetch 会通过 `ctx.signal` 立即中断（如果工具 honor signal）。

## 7. 测试矩阵建议

不同层有对应模式：

| 层 | 测试套路 | 样板文件 |
|---|---|---|
| 单工具 | 直接 import + mock fetch / mock ctx.rpc | `tests/tools/readPage.test.ts` |
| Skill 解析 / Registry | 完全 in-memory | `tests/agent-core/parseSkillMd.test.ts` |
| agent loop | 用真的 createAgent + 假 fetch（mock LLM 流） | `tests/agent-core/createAgent.test.ts` |
| agent service 编排 | 全 deps 注入 + stub createAgent | `tests/agent/agentService.test.ts` |
| RPC 路由 | 真 hub + 假 offscreen | `tests/rpc/hub-forward.test.ts` |
| SDK 端到端 | 真 hub + 假 offscreen + 真 RpcClient | `tests/agent-client/agentClient.test.ts` |
| 多上下文 chrome 路由 | `tests/mocks/chromeMultiContext.ts` 里的总线 | `tests/extension/domOp.routing.test.ts` |
| 真 LLM 端到端 | gated by `MYCLI_TEST_API_KEY` | `tests/integration/agent.live.test.ts` |

加新东西时：找对应行的样板 cp 一份改。

## 8. 常见踩坑

- **`chrome.storage` 在 offscreen 是 undefined**（某些 Chrome 版本）— `src/extension/offscreenChromePolyfill.ts` 自动 polyfill 走 SW 代理。新增的 chrome.* 调用如果在 offscreen 又 polyfill 不在覆盖范围内，扩展 `src/extension/domOpRouter.ts` 的 `handleChromeApi` switch。
- **content 脚本 orphan**（重载扩展后旧 tab）— 老 content 脚本的 `chrome.runtime` 失效。症状是发消息 30s 后 `ack_timeout`。修复：刷新 tab。
- **MV3 SW 30s idle 死掉** — 长跑工具或 LLM 不会自动 keep-alive。短工具 OK；超长操作要么走 offscreen（已经默认），要么显式 `chrome.alarms` keep-alive。
- **`import.meta.glob` 仅 Vite 上下文** — extension 内 OK，vitest OK，Bun CLI 不行。CLI 需要 fs loader（看 `scripts/agent-repl.ts`）。
- **GLM-4.6 reasoning_content 不显示** — 模型把大量 token 花在 `delta.reasoning_content`，我们的 `OpenAICompatibleClient.ts` 只读 `delta.content`。最终答案有，思考过程被丢。要显示需要扩 protocol。
- **Per-turn `tools` 白名单包含 `useSkill`/`readSkillFile`** — 默认 tool 列表里有这两个 skill 工具，如果调用方传 `tools: ['readPage']` 就会把 useSkill 也排除掉。要保留 skill 能力得显式 `tools: ['readPage', 'useSkill', 'readSkillFile']`。

## 9. 文件指路

| 主题 | 看哪 |
|---|---|
| agent loop / LLM 客户端 | `src/agent-core/` |
| 浏览器工具实现 | `src/extension-tools/tools/` |
| Skill 加载与查找 | `src/extension-skills/` |
| Chrome MV3 装配（SW + offscreen） | `src/extension/background.ts`、`offscreen.ts` |
| 跨进程 RPC | `src/extension/rpc/` |
| Agent 服务编排（可单测） | `src/extension/agentService.ts` |
| 给新 consumer 的 SDK | `src/extension/agent-client/` |
| CLI demo / 调试入口 | `scripts/agent-repl.ts` |
| 旧的架构总览 | [`architecture.md`](./architecture.md) |
| agent-core 单层用法 | [`agent-core-usage.md`](./agent-core-usage.md) |
| Skills 设计 spec | [`superpowers/specs/2026-05-10-skills-design.md`](./superpowers/specs/2026-05-10-skills-design.md) |
| 最近一次 skills 实施备忘 | [`superpowers/HANDOFF-2026-05-10-skills.md`](./superpowers/HANDOFF-2026-05-10-skills.md) |
