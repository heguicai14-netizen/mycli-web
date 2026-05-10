# Agent 框架接入文档

面向**在本仓内开发**的人。回答"我想加 X，应该改哪"。不重复 [`architecture.md`](./architecture.md)（架构总览）和 [`packages/agent-kernel/docs/api-reference.md`](../packages/agent-kernel/docs/api-reference.md)（kernel 公开 API），看完本文如果还想深挖某层，跳那两篇。

## 1. 框架是什么

仓现在是 **Bun workspace**，两个包：

```
┌─ packages/agent-kernel/ ──────────────────────────────────────┐
│  可复用的 agent kernel 库（不发 npm；workspace dep）           │
│   • core/      —— LLM 循环、工具协议、Skill 协议、注册表       │
│   • browser/   —— Chrome MV3 装配 helper、RPC、SDK             │
│   • adapters/  —— SettingsAdapter / MessageStoreAdapter /     │
│                   ToolContextBuilder（消费方实现）             │
│   • skills/    —— SkillRegistry、parseSkillMd、元工具 factory │
│                   + viteGlob / fs loaders                     │
│   • tools/fetchGet —— 唯一 built-in 跨环境工具                │
│   • errors    —— ErrorCode + classifyError                    │
│  公开 API 全部从 `agent-kernel` import（bare specifier）       │
└───────────────────────────────────────────────────────────────┘
                        ▲ 消费方依赖
                        │ "agent-kernel": "workspace:*"
                        │
┌─ packages/mycli-web/ ─────────────────────────────────────────┐
│  reference Chrome 扩展                                         │
│   • src/extension/         —— SW + offscreen + content + UI    │
│   •   ├ background.ts      ← 调 installKernelBackground       │
│   •   ├ offscreen.ts       ← 调 bootKernelOffscreen           │
│   •   ├ settingsAdapter.ts ← 实现 SettingsAdapter             │
│   •   ├ content/, ui/      ← Shadow DOM React UI              │
│   •   └ storage/           ← chrome.storage 包装（自家）       │
│   • src/extension-tools/   —— readPage、screenshot、tabs ...   │
│   • src/extension-skills/  —— bundled .md skill 内容           │
│   • scripts/agent-repl.ts  —— Bun CLI demo（用 fsLoader）      │
└───────────────────────────────────────────────────────────────┘
```

`packages/mycli-web/scripts/agent-repl.ts`：纯 Bun 跑的 CLI，用 kernel 的 `loadSkillsFromFs` 把 agent + tools + skills 串起来，作为 demo / 调试入口。

## 2. 决策树：你想做什么？

| 想做什么 | 改哪 | 工作量 | 详见 |
|---|---|---|---|
| 加一个浏览器特化工具（例如 `getWeather`） | `packages/mycli-web/src/extension-tools/tools/<name>.ts` + `index.ts` | 30 分钟 | §3.1 |
| 加一个跨环境通用工具（只用 fetch / 任意环境可用） | `packages/agent-kernel/src/tools/<name>.ts` + `index.ts` re-export | 30 分钟 | §3.1 |
| 加一个新 skill（纯文本指令包） | `packages/mycli-web/src/extension-skills/skills/<name>/SKILL.md` | 5 分钟 | §3.2 |
| 在扩展里某个新地方调 agent（右键菜单 / options 页 / background alarm） | `import { createAgentClient } from 'agent-kernel'` | 1 小时 | §3.3 |
| 在扩展外（CLI、Bun、Node）单独跑 agent | 直接用 kernel 的 `createAgent` | 见 [agent-core-usage.md](./agent-core-usage.md) | §3.4 |
| 写一个完全自定义的 agent 后端（不用 chrome.storage / IDB） | 实现自己的 SettingsAdapter / MessageStoreAdapter / ToolContextBuilder，传给 `bootKernelOffscreen` 或在非 chrome 环境直接用 `createAgent` | 半天 | §3.5 |
| 写一个全新的 kernel 消费方扩展（不是 mycli-web） | 在 workspace 内新建 `packages/<name>/` 包，依赖 `"agent-kernel": "workspace:*"`，按 [`packages/agent-kernel/docs/getting-started.md`](../packages/agent-kernel/docs/getting-started.md) 接入 | 半天起 | §3.6 |
| 改 LLM provider（Bedrock / Anthropic Messages API） | **不支持**——有意限定 OpenAI-compatible only | — | — |
| 暴露 HTTP / SSE 给外部进程 | **不支持**（MV3 扩展不能 listen 端口）；要一个伴生进程 | — | — |

## 3. 场景详解

### 3.1 加一个新工具

工具是 LLM 可见的可调用函数。最小接口：

```ts
import type { ToolDefinition } from 'agent-kernel'
import { makeOk, makeError } from 'agent-kernel'

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

注册：在 `packages/mycli-web/src/extension-tools/index.ts` 的 `extensionTools` 数组里加上。

```ts
// packages/mycli-web/src/extension-tools/index.ts
import { getWeatherTool } from './tools/getWeather'
export const extensionTools = [
  readPageTool, readSelectionTool, querySelectorTool,
  screenshotTool, listTabsTool,
  getWeatherTool,   // ← 加这里
]
```

完事。下次 build 后所有 agent 入口（聊天、REPL、SDK consumer）都能调用。

**契约**（kernel 强制）：
- `execute` 必须返回 `ToolResult<T> = { ok: true, data } | { ok: false, error }`，**不能 throw**——agent loop 会把 throw 当成 LLM 致命错误，工具应该用 `makeError` 表达可恢复失败。
- `makeError(code, message, retryable=false)`：retryable=true 时 LLM 会更倾向重试。
- 需要浏览器能力（DOM 操作、tabs 等）：通过 `ctx.rpc.domOp(...)` / `ctx.rpc.chromeApi(...)`，offscreen 装配点（`packages/mycli-web/src/extension/offscreen.ts`）已经接好。看 `extension-tools/tools/readPage.ts` 模板。
- 需要当前 tab id：`ctx.tabId`（offscreen 装配层算好的）。

**跨环境通用工具**（不依赖 chrome）：放进 `packages/agent-kernel/src/tools/` 而不是 mycli-web，并在 `packages/agent-kernel/src/index.ts` re-export。

**写测试**（每个工具都该有）：

```ts
// packages/mycli-web/tests/tools/getWeather.test.ts
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

参考样板：`packages/agent-kernel/tests/core/fetchGet.test.ts`、`packages/mycli-web/tests/tools/readPage.test.ts`。

### 3.2 加一个新 skill

Skill 是给 LLM 的"配方"——一段 markdown 指令，LLM 通过 `useSkill(name)` 加载后按里面步骤执行（用现有工具）。skill 内容**全部由消费方提供**——kernel 不打包任何 skill，只提供协议和 loader。

```bash
mkdir -p packages/mycli-web/src/extension-skills/skills/translateSelection
cat > packages/mycli-web/src/extension-skills/skills/translateSelection/SKILL.md <<'EOF'
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
mkdir -p packages/mycli-web/src/extension-skills/skills/translateSelection/references
cat > packages/mycli-web/src/extension-skills/skills/translateSelection/references/style.md <<'EOF'
# 翻译风格

- 中→英：技术内容用平实英语，不要用 marketing 措辞
- 英→中：保留原文专有名词不译（API 名、人名、产品名）
- 代码块内的注释也要翻
EOF
```

`bun --cwd packages/mycli-web run build` 后，新 skill 自动出现在 `useSkill` 的列表里。**零代码改动**——`packages/mycli-web/src/extension-skills/index.ts` 内部用 `import.meta.glob('./skills/**/*.md', { query: '?raw', eager: true, import: 'default' })` 收所有 .md，然后调 kernel 的 `loadSkillsFromViteGlob` 装成 SkillRegistry。

**约束**（kernel 强制）：
- 文件夹名 = SKILL.md 的 `name` 字段（不一致 build 时报错）
- frontmatter 必须有 `name` 和 `description`，都是字符串
- skill 文件夹精确一层深（`skills/<name>/`，但内部可以再分子目录）
- 重名 skill build 时报错

完整设计见 [`docs/superpowers/specs/2026-05-10-skills-design.md`](./superpowers/specs/2026-05-10-skills-design.md)。

### 3.3 在扩展里某个新地方调 agent

聊天框只是 agent 的一个 consumer。要在右键菜单、options 页、background alarm、popup 等地方也调 agent，用 kernel 的 **`createAgentClient()` SDK**：

```ts
// 任何 extension context（content / options / popup / background）
import { createAgentClient } from 'agent-kernel'

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
- **自动心跳**：`createAgentClient` 内置 25s `setInterval` ping 给 SW 续命；要关掉传 `heartbeatMs: 0`。

完整 API 在 `packages/agent-kernel/src/browser/agentClient/index.ts`，单测在 `packages/agent-kernel/tests/browser/agentClient.test.ts`。

**新 consumer 的接入清单**：
1. 在你的 extension context（content/options/popup/background）import SDK：`import { createAgentClient } from 'agent-kernel'`
2. 决定 streaming（用 `message()`）还是 oneshot（用 `oneShot()`）
3. 决定要不要 `ephemeral`、`tools` 限定、`system` 覆盖
4. 写测试（参考 `packages/agent-kernel/tests/browser/agentClient.test.ts` 用 `installHub` + 假 offscreen 模拟）

### 3.4 在扩展外用 agent（CLI / Bun / Node）

如果只想 CLI 跑 agent（比如做 eval、批跑、烟雾测试），跳过整个 extension 层，直接用 kernel core。

最简范式：

```ts
import { createAgent, fetchGetTool, type ChatMessage } from 'agent-kernel'

const agent = createAgent({
  llm: { apiKey: '...', baseUrl: '...', model: '...', fetchTimeoutMs: 60_000 },
  tools: [fetchGetTool],
  toolContext: {},
})

const history: ChatMessage[] = []
for await (const ev of agent.send('你好', { history })) {
  if (ev.kind === 'message/streamChunk') process.stdout.write(ev.delta)
}
```

完整样板看 `packages/mycli-web/scripts/agent-repl.ts`：完整 CLI，含 fs-based skills loader（`loadSkillsFromFs`，绕开 vite glob）、彩色输出、slash 命令。直接 `cp` 改改就能起新场景。

详细 API 见 [`packages/agent-kernel/docs/api-reference.md`](../packages/agent-kernel/docs/api-reference.md)。

### 3.5 自定义 adapter（替换 settings / 持久化 / tool ctx）

如果不想用默认的 chrome.storage / IndexedDB 持久化，自己控制 settings 来源、消息存储、tool 上下文 —— 实现 kernel 的三个 adapter，然后传给 `bootKernelOffscreen`：

```ts
import {
  bootKernelOffscreen,
  createIdbMessageStore,
  fetchGetTool,
  type SettingsAdapter,
  type MessageStoreAdapter,
  type ToolContextBuilder,
} from 'agent-kernel'

const mySettings: SettingsAdapter = {
  async load() {
    return {
      apiKey: process.env.OPENAI_KEY!,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    }
  },
}

// 不想用 IDB？自己实现 4 个方法即可
const myMessageStore: MessageStoreAdapter = {
  async activeConversationId() { /* ... */ return 'conv-1' },
  async append(msg) { /* ... */ return { id: '...', createdAt: 0 } },
  async list(cid) { /* ... */ return [] },
  async update(id, patch) { /* ... */ },
}

const myToolContext: ToolContextBuilder = {
  async build(cid) {
    return {
      rpc: { domOp: myDomDriver, chromeApi: myChromeStub },
      tabId: undefined,
      conversationId: cid,
    }
  },
}

bootKernelOffscreen({
  settings: mySettings,
  messageStore: myMessageStore,           // 或 createIdbMessageStore() 用 kernel 默认
  toolContext: myToolContext,
  tools: [fetchGetTool /* + 你自己的工具 */],
})
```

详见 [`packages/agent-kernel/docs/adapters.md`](../packages/agent-kernel/docs/adapters.md)。

mycli-web 自己的 adapter 实现作为参考：
- `packages/mycli-web/src/extension/settingsAdapter.ts`（`SettingsAdapter`）
- 默认 `createIdbMessageStore({ defaultConversationTitle: 'New chat' })`（不覆盖）
- `ToolContextBuilder` inline 在 `packages/mycli-web/src/extension/offscreen.ts` 内

**用这条路的典型场景**：
- 写另一个 Chrome 扩展，不想用 IDB 想存 chrome.storage.sync
- 写 Native Messaging 伴生进程，对外暴露 HTTP/SSE
- 写一个不依赖 chrome 的 desktop app（Electron）复用 agent 逻辑
- 想要 SQLite / 远端 KV 等不同的持久化方案

### 3.6 写一个全新的 kernel 消费方扩展

不想 fork mycli-web、想从 0 开始写一个 kernel-powered 扩展？在 workspace 里新开个包：

```bash
mkdir -p packages/my-extension/src
cd packages/my-extension
# 写 package.json，依赖 "agent-kernel": "workspace:*"
# 写 manifest.json + vite.config.ts + html/offscreen.html
```

然后照 [`packages/agent-kernel/docs/getting-started.md`](../packages/agent-kernel/docs/getting-started.md) 5 步走：

1. background.ts → `installKernelBackground({...})`
2. offscreen.ts → `polyfillChromeApiInOffscreen()` + `bootKernelOffscreen({...})`
3. content.ts → `createAgentClient()` 接 UI
4. 加自己的 `ToolDefinition` 进 `tools` 数组
5. 加 `.md` skills + `loadSkillsFromViteGlob`

`packages/mycli-web/` 是完整的参考实现——cargo cult 即可。

## 4. 类型速查

```ts
// agent-kernel/src/core/types.ts
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

// agent-kernel/src/skills/Skill.ts
SkillDefinition = {
  name: string
  description: string
  body: string                       // SKILL.md 正文
  files: Record<string, string>      // 其他 .md，相对路径为 key
  meta?: Record<string, string>      // 未知 frontmatter 字段
}

// agent-kernel/src/browser/agentClient/index.ts
MessageOptions = {
  text: string
  system?: string                    // 覆盖 system prompt
  tools?: string[]                   // 工具白名单（按 name 过滤）
  model?: string                     // 覆盖 model
  ephemeral?: boolean                // true = 不写持久化、不读历史
}
```

完整公开 API 详解见 [`packages/agent-kernel/docs/api-reference.md`](../packages/agent-kernel/docs/api-reference.md)。

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

### 5.2 LLM 致命错误 + ErrorCode 分类

如果 LLM endpoint 挂了（auth fail、URL 错、超时、rate limit），agent 会 emit 一个 `done` event 带 `stopReason: 'error'`，并附 `error.code`（来自 `ErrorCode` 枚举）：

```ts
import { ErrorCode } from 'agent-kernel'

for await (const ev of agent.send(...)) {
  if (ev.kind === 'done' && ev.stopReason === 'error') {
    if (ev.error?.code === ErrorCode.Auth) {
      showToast('请检查 API key')
    } else if (ev.error?.code === ErrorCode.Timeout) {
      showToast('请求超时，可重试')
    }
    // 等等
  }
}
```

`ErrorCode` 全集：`Network` / `Auth` / `RateLimit` / `BadRequest` / `Server` / `Timeout` / `Abort` / `ToolError` / `Schema` / `Unknown`。详见 `packages/agent-kernel/src/errors.ts` 和 `tests/core/classifyError.test.ts`。

`OpenAICompatibleClient` 的 `fetchTimeoutMs` 默认 60_000；超时会被 classifyError 标成 `ErrorCode.Timeout`。

### 5.3 SW / offscreen 运行时错误

任何 `unhandledrejection` / `error` 在 SW 或 offscreen 里被 kernel 捕获后，会**自动转发**到所有活跃 session port，作为 `runtime/error` event 出现在 content tab 的 F12 console。不需要单独看 SW DevTools。

实现细节：`packages/agent-kernel/src/browser/rpc/hub.ts` 的 runtime-error 广播；消费方在 `ChatApp.tsx` 监听这个事件并 console.error。

## 6. 取消

每个进入中的 turn 都注册了 cancel：

```ts
// 来自 ChatApp / SDK：
clientRef.current.send({ kind: 'chat/cancel' })

// 直接用 kernel core：
const stream = agent.send('...')
setTimeout(() => agent.cancel(), 200)
for await (const ev of stream) { /* 会收到 done with stopReason='cancel' */ }
```

工具执行中的 fetch 会通过 `ctx.signal` 立即中断（如果工具 honor signal）。

**契约**：`agent.cancel()` 调用后 ≤2s 内 stream 必须 yield 终止 done event（`stopReason: 'cancel'`）。Kernel 内部所有等待都接 AbortSignal。

## 7. 测试矩阵建议

不同层有对应模式：

| 层 | 测试套路 | 样板文件 |
|---|---|---|
| 单工具 | 直接 import + mock fetch / mock ctx.rpc | `packages/mycli-web/tests/tools/readPage.test.ts` |
| Skill 解析 / Registry | 完全 in-memory | `packages/agent-kernel/tests/skills/parseSkillMd.test.ts` |
| agent loop | 用真的 createAgent + 假 fetch（mock LLM 流） | `packages/agent-kernel/tests/core/createAgent.test.ts` |
| agent service 编排 | 全 deps 注入 + stub createAgent | `packages/agent-kernel/tests/browser/agentService.test.ts` |
| RPC 路由 | 真 hub + 假 offscreen | `packages/agent-kernel/tests/browser/hub-forward.test.ts` |
| SDK 端到端 | 真 hub + 假 offscreen + 真 RpcClient | `packages/agent-kernel/tests/browser/agentClient.test.ts` |
| 多上下文 chrome 路由 | `packages/mycli-web/tests/mocks/chromeMultiContext.ts` 总线 | `packages/mycli-web/tests/extension/domOp.routing.test.ts` |
| 真 LLM 端到端 | gated by `MYCLI_TEST_API_KEY` | `packages/agent-kernel/tests/integration/agent.live.test.ts` |

加新东西时：找对应行的样板 cp 一份改。

## 8. 常见踩坑

- **`chrome.storage` 在 offscreen 是 undefined**（某些 Chrome 版本）— kernel 的 `polyfillChromeApiInOffscreen()` 自动 polyfill 走 SW 代理。新增的 chrome.* 调用如果在 offscreen 又 polyfill 不在覆盖范围内，扩展 kernel 的 `domOpRouter` 的 `handleChromeApi` switch。
- **content 脚本 orphan**（重载扩展后旧 tab）— 老 content 脚本的 `chrome.runtime` 失效。症状是发消息 30s 后 `ack_timeout`。修复：刷新 tab。
- **MV3 SW 30s idle 死掉** — `createAgentClient` 自带 25s 心跳；其他长连用法也要类似处理。短工具 OK；超长操作要么走 offscreen（已经默认），要么显式 `chrome.alarms` keep-alive。
- **`import.meta.glob` 仅 Vite 上下文** — extension build 内 OK，vitest OK，Bun CLI 不行。CLI 用 kernel 的 `loadSkillsFromFs`（看 `packages/mycli-web/scripts/agent-repl.ts`）。
- **GLM-4.6 reasoning_content 不显示** — 模型把大量 token 花在 `delta.reasoning_content`，kernel 的 `OpenAICompatibleClient` 只读 `delta.content`。最终答案有，思考过程被丢。要显示需要扩 protocol。
- **Per-turn `tools` 白名单包含 `useSkill`/`readSkillFile`** — 默认 tool 列表里有这两个 skill 工具，如果调用方传 `tools: ['readPage']` 就会把 useSkill 也排除掉。要保留 skill 能力得显式 `tools: ['readPage', 'useSkill', 'readSkillFile']`。
- **kernel 改了之后只跑 mycli-web 测试不够** — 必须 kernel 测试 + mycli-web 测试 + mycli-web build 都过。`bun run typecheck` 能在编译期早期发现签名变化。

## 9. 文件指路

| 主题 | 看哪 |
|---|---|
| agent loop / LLM 客户端 | `packages/agent-kernel/src/core/` |
| Skill 协议 + 元工具 + loaders | `packages/agent-kernel/src/skills/` |
| 浏览器 RPC + SDK + 装配 helper | `packages/agent-kernel/src/browser/` |
| 三个消费方接口 | `packages/agent-kernel/src/adapters/` |
| ErrorCode + classifyError | `packages/agent-kernel/src/errors.ts` |
| Kernel 公开 API barrel | `packages/agent-kernel/src/index.ts` |
| 浏览器特化业务工具实现 | `packages/mycli-web/src/extension-tools/tools/` |
| Skill 内容 + 加载入口 | `packages/mycli-web/src/extension-skills/` |
| Chrome MV3 装配（消费方端） | `packages/mycli-web/src/extension/background.ts`、`offscreen.ts` |
| 消费方实现的 SettingsAdapter | `packages/mycli-web/src/extension/settingsAdapter.ts` |
| 消费方自家 chrome.storage 包装 | `packages/mycli-web/src/extension/storage/` |
| CLI demo / 调试入口 | `packages/mycli-web/scripts/agent-repl.ts` |
| 架构总览 | [`architecture.md`](./architecture.md) |
| Kernel API reference | [`packages/agent-kernel/docs/api-reference.md`](../packages/agent-kernel/docs/api-reference.md) |
| Kernel getting started | [`packages/agent-kernel/docs/getting-started.md`](../packages/agent-kernel/docs/getting-started.md) |
| Kernel adapter 实现指南 | [`packages/agent-kernel/docs/adapters.md`](../packages/agent-kernel/docs/adapters.md) |
| Skills 设计 spec | [`superpowers/specs/2026-05-10-skills-design.md`](./superpowers/specs/2026-05-10-skills-design.md) |
| Workspace 抽核 spec | [`superpowers/specs/2026-05-10-agent-kernel-extraction-design.md`](./superpowers/specs/2026-05-10-agent-kernel-extraction-design.md) |
