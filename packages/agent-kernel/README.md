# agent-kernel

可复用的 Chrome MV3 浏览器 agent 内核。把 LLM 循环、工具协议、多会话存储、自动压缩、跨进程 RPC、Skills 系统全部打包好，留给你只需要写 UI 和业务工具的状态。

**当前状态**：production-ready · 233 单测 + 12 真模型 E2E + 18 任务 eval（GLM-4.6 18/18 通过，平均分 0.93）。

---

## 内容索引

- [适合谁用](#适合谁用)
- [架构](#架构)
- [10 分钟接入](#10-分钟接入)
  - [安装](#1-安装)
  - [Background SW](#2-background-sw-≈10-行)
  - [Offscreen 文档](#3-offscreen-文档)
  - [Content 脚本](#4-content-脚本)
- [写工具](#写工具)
- [写 Skills](#写-skills)
- [自动压缩配置](#自动压缩配置)
- [Tool 结果截断](#tool-结果截断)
- [多会话管理](#多会话管理)
- [Token 用量监控](#token-用量监控)
- [测试 / Eval](#测试--eval)
- [完整参考](#完整参考)

---

## 适合谁用

- 想做**浏览器 agent**（Chrome MV3 扩展）
- LLM 是 **OpenAI 兼容**（OpenAI / Azure / Zhipu / OpenRouter / 自部署 vLLM 都行）
- 不想自己写 SW ↔ offscreen 跨进程通信
- 不想自己实现 tool 调用循环 / 流式 / 持久化 / 自动压缩
- 想把**所有这些复杂度**藏在 ~10 行 boilerplate 里

不适合：非 Chrome 扩展（Web app / Electron 不需要这套 SW/offscreen 架构）；非 OpenAI 兼容协议（Anthropic / Bedrock / Vertex —— 不在范围）。

---

## 架构

四个进程上下文，**memory 不共享，只能用 message-passing**：

```
┌─────────────────────┐  long-lived port    ┌──────────────────────┐  long-lived port    ┌──────────────────────┐
│  Content Script     │ ──── 'session' ───→ │  Service Worker      │ ── 'sw-to-offscreen'│  Offscreen Document  │
│  (per tab)          │                     │  (Hub: 路由)         │                     │  (Agent loop here)   │
│                     │                     │                      │                     │                      │
│  RpcClient          │ ←── chrome.runtime ─│  installKernelBg     │ ←── chrome.runtime ─│  bootKernelOffscreen │
│  你的 chat UI       │     broadcast (tool)│  + dom op router     │     broadcast (tool)│  + IDB + LLM client  │
└─────────────────────┘                     └──────────────────────┘                     └──────────────────────┘
                                                                                                       │
                                                                                                       │ HTTP
                                                                                                       ▼
                                                                                              [LLM API endpoint]
```

| 上下文 | 你写的 | kernel 替你写的 |
|---|---|---|
| **Content** | UI（React 也行）+ `RpcClient` 调用 | 序列化 / 重连 / Zod 校验 / 心跳 |
| **SW** | 一行 `installKernelBackground(...)` | Hub 路由 / dom op 路由 / chrome.* 代理 / offscreen 生命周期 / 快捷键 |
| **Offscreen** | 配 settings / messageStore / 注册 tools | QueryEngine 循环 / 流式 / 工具调度 / IDB / 自动压缩 / 多会话 |
| **Sandbox iframe**（可选）| Skill 的 `tools.js` | Null-origin sandbox 隔离 |

---

## 10 分钟接入

### 1. 安装

monorepo 里：
```json
// 你的扩展包 package.json
"dependencies": { "agent-kernel": "workspace:*" }
```

monorepo 外（同一 repo 不同位置 / 复制 kernel 源码）：
```bash
bun add file:../path/to/agent-kernel
```

### 2. Background SW（≈10 行）

`background.ts`:
```ts
import { installKernelBackground } from 'agent-kernel'

installKernelBackground({
  offscreenUrl: chrome.runtime.getURL('html/offscreen.html'),
  offscreenReason: 'IFRAME_SCRIPTING' as chrome.offscreen.Reason,
  hubMode: 'offscreen-forward',
  toggleCommand: 'toggle-chat',  // 跟 manifest 的 commands 同名
})
```

完了。kernel 替你处理：Hub 安装、tool 调用路由、`chrome.action.onClicked`、键盘快捷键转发、SW/offscreen 生命周期。

### 3. Offscreen 文档

`offscreen.ts`:
```ts
import {
  bootKernelOffscreen,
  createIdbMessageStore,
  fetchGetTool,
  polyfillChromeApiInOffscreen,
  type ToolContextBuilder,
  type SettingsAdapter,
} from 'agent-kernel'

polyfillChromeApiInOffscreen()  // offscreen 缺 chrome.storage/tabs，这行装回来

// 1) 你的 settings 怎么读
const settings: SettingsAdapter = {
  async load() {
    const r = await chrome.storage.local.get('mySettings')
    return r.mySettings ?? { apiKey: '', baseUrl: '', model: 'gpt-4o-mini' }
  },
}

// 2) tool 上下文（tabId / DOM RPC 等）
const toolContext: ToolContextBuilder = {
  async build(cid) {
    return { conversationId: cid }
  },
}

// 3) 启动
bootKernelOffscreen({
  settings,
  messageStore: createIdbMessageStore(),  // 默认 IDB 实现，全套多会话/压缩/markCompacted 已挂
  toolContext,
  tools: [fetchGetTool /* + 你的工具 */],
})
```

`html/offscreen.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><script type="module" src="../src/offscreen.ts"></script></body></html>
```

### 4. Content 脚本

`content.ts`:
```ts
import { RpcClient } from 'agent-kernel'

const client = new RpcClient({ portName: 'session' })
await client.connect()

// 监听 agent 流式输出
client.on('message/streamChunk', (ev) => {
  console.log('chunk:', ev.delta)
})
client.on('message/appended', (ev) => {
  if (ev.message.role === 'assistant' && !ev.message.pending) {
    console.log('final:', ev.message.content)
  }
})
client.on('tool/start', (ev) => console.log('tool:', ev.toolCall.tool))
client.on('tool/end', (ev) => console.log('result ok:', ev.result.ok))

// 发消息
await client.send({ kind: 'chat/send', text: '你好' })
```

完整类型化的事件清单见 [api-reference.md](./docs/api-reference.md)。

---

## 写工具

工具是 `ToolDefinition`，三种执行位置：

```ts
import { type ToolDefinition, makeOk, makeError } from 'agent-kernel'

const greetTool: ToolDefinition<{ name: string }, { greeting: string }, any> = {
  name: 'greet',
  description: 'Returns a personalized greeting.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!input?.name) return makeError('invalid_input', 'name required')
    return makeOk({ greeting: `Hello, ${input.name}!` })
  },
}
```

| 工具想干什么 | 怎么实现 |
|---|---|
| **纯 offscreen 计算 / fetch** | 直接在 `execute` 里写就行（如上例），不用碰 chrome.* |
| **读/改用户当前页面 DOM** | `execute` 里 `await ctx.rpc.domOp('readText', { selector: 'h1' })` —— 自动路由到 content script |
| **chrome.tabs / chrome.windows / 截图** | `execute` 里 `await ctx.rpc.chromeApi('captureVisibleTab')` —— 自动路由到 SW |

ctx 由你的 `ToolContextBuilder.build(cid)` 提供，完整接口见 [adapters.md](./docs/adapters.md)。

---

## 写 Skills

Skills 是**用户可安装**的 agent 行为模板（一份 markdown + 可选 tools.js）。

```
my-extension/src/skills/
└── summarize/
    └── SKILL.md
```

`SKILL.md`:
```markdown
---
name: summarize
description: Summarize the user's input in three bullet points.
---

# Instructions
1. Read the user's input or use readPage tool.
2. Identify the three most important points.
3. Reply with a markdown bullet list. Bold each key term.
```

加载（offscreen.ts 里）：
```ts
import {
  loadSkillsFromViteGlob,
  createUseSkillTool,
  createReadSkillFileTool,
} from 'agent-kernel'

const skillModules = import.meta.glob('./skills/**/*.md', {
  query: '?raw', eager: true, import: 'default',
}) as Record<string, string>
const skillRegistry = loadSkillsFromViteGlob(skillModules)

const useSkill = createUseSkillTool({ registry: skillRegistry })
const readSkillFile = createReadSkillFileTool({ registry: skillRegistry })

bootKernelOffscreen({
  /* ... */
  tools: [fetchGetTool, useSkill, readSkillFile /* + 业务工具 */],
})
```

LLM 现在能看到 `useSkill` 工具，按需 `useSkill({ name: 'summarize' })` 加载。

---

## 自动压缩配置

会话历史超阈值时自动调 LLM 做摘要，把老消息标 `compacted` 替换成 system-synth 摘要。

```ts
// 你的 SettingsAdapter.load() 返回值里加：
return {
  apiKey: '...',
  baseUrl: '...',
  model: '...',
  autoCompact: {
    enabled: true,
    modelContextWindow: 128_000,   // gpt-4o = 128k, gpt-3.5 = 16k, glm-4.6 = 128k+
    thresholdPercent: 75,           // 用到 75% 触发 → 96k
    keepRecentMessages: 6,          // 保留最近 6 条原文
  },
}
```

**事件回流到 UI**：

```ts
client.on('compact/started', (ev) => {
  showBanner(`Compacting ${ev.messagesToCompact} messages…`)
})
client.on('compact/completed', (ev) => {
  showBanner(`Saved ~${ev.beforeTokens - ev.afterTokens} tokens`)
})
client.on('compact/failed', (ev) => {
  showBanner(`Compact skipped: ${ev.reason}`, 'warn')
})
```

**失败安全**：summarize 调用失败 → 发 `compact/failed` 事件 → 退化为不压缩继续聊。

---

## Tool 结果截断

防止单个大 tool 返回（200KB 网页 / 1MB JSON）撑爆 LLM context。

```ts
// SettingsAdapter.load() 返回值：
return {
  /* ... */
  toolMaxOutputChars: 50_000,  // 0 = 不截断；默认推荐 50000 ≈ 12.5k tokens
}
```

**两层截断点**：
1. **同 turn 内**：tool 返回的 content push 到 LLM history 前截断
2. **跨 turn replay**：buildPriorHistory 把 IDB 里的 tool 行 content 截断后再送 LLM

**关键**：IDB 里**永远存全文**，UI 通过 `tool/end` 事件**永远看全文**。只 LLM 看的副本被截断。

---

## 多会话管理

后端 CRUD + active 状态全套已实现。给你 4 个 cmd + 1 个事件。

**Cmd（content → offscreen）**：

| Cmd | 说明 |
|---|---|
| `chat/newConversation` | 创建新会话 + 设为 active |
| `chat/loadConversation` | 切换到指定会话 |
| `chat/listConversations` | 拉所有会话列表 |
| `chat/deleteConversation` | 删除（active 自动 fallback 到 latest）|

**事件（offscreen → content）**：

| Event | 数据 |
|---|---|
| `conversations/list` | `{ activeId, conversations: [{id, title, createdAt, updatedAt}] }` |
| `state/snapshot` | 切换/新建/删除后 push 当前会话的全部消息 |

**典型 UI 整合**：

```ts
const [conversations, setConversations] = useState([])
const [activeId, setActiveId] = useState(null)

client.on('conversations/list', (ev) => {
  setConversations(ev.conversations)
  setActiveId(ev.activeId)
})

// 启动时拉一次
await client.send({ kind: 'chat/listConversations' })

// 用户点列表里某条
function switchTo(id) {
  client.send({ kind: 'chat/loadConversation', conversationId: id })
}

// 用户点 New
function newChat() {
  client.send({ kind: 'chat/newConversation' })
}

// 用户点删
function deleteChat(id) {
  client.send({ kind: 'chat/deleteConversation', conversationId: id })
}
```

active conversation id 自动持久化到 `chrome.storage.local`，跨 SW 重启 / tab 重开都保留。

参考实现：`packages/mycli-web/src/extension/ui/ConversationList.tsx`。

---

## Token 用量监控

每次 LLM 调用回流的 token 数（如果 provider 返回的话 —— 部分国产模型不返回）：

```ts
client.on('message/usage', (ev) => {
  console.log('input tokens (=current context size):', ev.input)
  console.log('output tokens this iter:', ev.output)
  // 配合 settings.autoCompact.modelContextWindow 可以算占用百分比
  const pct = (ev.input / 128_000) * 100
  updateContextBar(pct)
})
```

**Provider 兼容性**：
- ✅ OpenAI 官方 / Azure / OpenRouter 大部分 / GLM-4.6 部分场景
- ❌ 智谱 GLM-4-flash 流式不返 usage（已知 quirk）
- 🟡 自部署 vLLM：取决于版本和 `stream_options.include_usage` 支持

如果 provider 不返 usage，事件就不发，UI 可以 fallback 到自己用 `estimateTokens`（`@ kernel 里` `core/tokenBudget.ts` 暴露了）估算。

---

## 测试 / Eval

### 单元 + 集成
```bash
bun run test                # 单元 + storage + RPC + UI（不烧 token）
bun run test:watch          # watch 模式
bun run test:changed        # 只跑 git 改动相关
```

### 真模型 E2E
```bash
cp .env.example .env        # 配 MYCLI_TEST_API_KEY 等
bun run test:live           # 12 case real-LLM E2E（约 60-120s，烧少量 token）
```

### Eval（评估 agent 能力）

`packages/agent-kernel/eval/` 是独立的 evaluation harness，**不只用来测你的 agent，更是测你接的模型**：

```bash
cd packages/mycli-web
MYCLI_LLM_API_KEY=sk-xxx bun run eval                        # 全 18 任务
MYCLI_LLM_API_KEY=sk-xxx bun run eval -- --filter=L1         # 只跑 basic 6 个
MYCLI_LLM_API_KEY=sk-xxx bun run eval -- --filter=id:L2/issue-summary  # 单个任务
```

输出位置：`./eval-out/{timestamp}-{model}/report.md`（也有 json）

任务分布：
- **L1 basic**（6 个）：单步工具调用 —— 提取标题、读 selection、列 tabs、screenshot、单 selector、单 fetch
- **L2 chain**（8 个）：2-3 步链式 —— 多 tab 比较、issue 总结、条件分支、失败重试、跨数据源验证
- **L3 complex**（4 个）：分解 + 规划 + 恢复 + skill 编排

**GLM-4.6 实测分数**（修复 fixture 后）：18/18 通过，平均 composite 0.93，平均 ~2200 tokens/task。

加新任务：在 `eval/tasks/L?-*/` 写一个 `.task.ts`，会被 builtinSuite 自动收。

---

## 完整参考

| 文档 | 内容 |
|---|---|
| [docs/getting-started.md](./docs/getting-started.md) | 这份的简版 + 6 步骤手把手 |
| [docs/api-reference.md](./docs/api-reference.md) | 所有公开符号 / 类型 / 事件协议 |
| [docs/adapters.md](./docs/adapters.md) | SettingsAdapter / MessageStoreAdapter / ToolContextBuilder 详细接口 |
| [packages/mycli-web/](../mycli-web/) | 完整可跑的参考实现，约 2000 行业务代码 |

---

## 不提供的东西

| 不在 kernel 里 | 怎么办 |
|---|---|
| UI 组件 | 自己写 React / Vue 都行，参考 `mycli-web/src/extension/ui/` |
| 设置持久化 | 自己实现 `SettingsAdapter`（chrome.storage 包装一下就行）|
| 业务 tool（DOM 读写、截图、tabs 管理）| 在 consumer 实现，参考 `mycli-web/src/extension-tools/` |
| Skill 内容 | consumer 自己写 .md 放 `src/skills/` |
| 非 OpenAI 兼容 LLM 协议 | 故意排除（Anthropic / Bedrock / Vertex / MCP 不接）|

---

## 常见问题

**Q: SW 老死怎么办？**  
A: kernel 内置心跳（`createAgentClient` 用了 25s ping）+ runtime error 转发到 content F12。MV3 SW 会被 Chrome 杀，offscreen 在被需要时自动复活。

**Q: 多个 tab 同时聊会冲突吗？**  
A: 不会。每个 tab 独立 sessionId，hub 按 sessionId 路由事件。**所有 tab 共享同一个 active conversation**（默认行为），可以通过自定义 `MessageStoreAdapter` 改成按 origin/tab 隔离。

**Q: API key 安全吗？**  
A: 存 `chrome.storage.local`，只你自己 chrome profile 能访问。HTTPS 直传 LLM endpoint。**别在 web-accessible 资源里读 settings**。

**Q: 怎么换 provider？**  
A: 改 `SettingsAdapter.load()` 返回的 `baseUrl` + `model` + `apiKey` 即可。任何 OpenAI 兼容的 endpoint 都能用。

**Q: tool 结果会泄露给 LLM provider 吗？**  
A: 是的（tool 结果作为 chat history 发回 LLM 才能让模型用）。敏感数据用 prompt 让 LLM 不要回显，或在 tool 层做脱敏。

---

## License & 代码组织

- 内部包，不发布 npm
- TypeScript / ESM / Bun
- 所有跨进程消息走 Zod 校验（`browser/rpc/protocol.ts`）
- 233 单测 + 12 live + 18 eval task 全绿是发版门槛
