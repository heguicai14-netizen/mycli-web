# agent-core 接入文档

`@core` 是本仓内部模块（**不是**发布到 npm 的包），位于 `src/agent-core/`，对外暴露一个 transport-agnostic、env-agnostic 的 agent 引擎。本文档面向"想在浏览器场景里集成或扩展这个 agent"的开发者。

> 本文档假设你已经读过 `mycli-web/CLAUDE.md`、`docs/superpowers/specs/2026-04-24-mycli-web-design.md` 以及抽核 spec `docs/superpowers/specs/2026-05-07-agent-core-extraction-design.md`。

---

## 1. 何时使用 agent-core

agent-core 的目标是"配一个大模型 URL 就能跑出一个可用的工具调用 agent"。你应该用它当：

- 在 chrome MV3 扩展里加一种新的 chat surface（例如 popup、sidepanel、devtools 面板）
- 在普通网页里嵌一个"AI 助手聊天框"组件，浏览器里直接调 OpenAI-compatible 后端
- 在另一个浏览器扩展里复用同一套工具循环 + 协议

不该用它当：

- Node 端 CLI 或 server 进程（agent-core 用了 `crypto.randomUUID()` / `fetch` / `ReadableStream` 等浏览器原生 API；Node ≥ 24 大多数能跑，但本仓**不**为 Node 兜底）
- 想换 LLM provider 到 Bedrock / Vertex / Anthropic Messages API（非目标——只支持 OpenAI-compatible chat completions）
- 想用 MCP / OAuth / 本地 server bridge（非目标）

---

## 2. 五分钟接入：纯聊天 agent

最小用例：配置 LLM URL、传入空工具数组、消费事件流。

```ts
import { createAgent } from '@core'

const agent = createAgent({
  llm: {
    apiKey: 'sk-...',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  tools: [],
  toolContext: {},
})

for await (const ev of agent.send('帮我写一段 hello world')) {
  if (ev.kind === 'message/streamChunk') process.stdout.write(ev.delta)
  else if (ev.kind === 'done') console.log('\n[done]', ev.stopReason)
}
```

`agent.send()` 返回 `AsyncIterable<AgentEvent>`。事件类型见 §5。

要中断：

```ts
agent.cancel()
```

`cancel()` 是幂等的；调用后再次 `send()` 会自动复位 AbortController，session 可继续使用。

---

## 3. 加上"通用浏览器工具"：fetchGet

agent-core 自带一个跨环境工具 `fetchGetTool`（不依赖 chrome.\*，任何浏览器上下文都能用）。让 agent 能上网读 HTML：

```ts
import { createAgent, fetchGetTool } from '@core'

const agent = createAgent({
  llm: { apiKey, baseUrl, model },
  tools: [fetchGetTool],
  toolContext: {},
})

for await (const ev of agent.send('读 https://example.com 的 <title>')) {
  // ...
}
```

`fetchGetTool` 内部用 `credentials: 'omit'` + 200KB 截断，安全适配 agent 自由调用。

---

## 4. 加上"扩展工具集"：DOM 读取、截图、列 tab

如果你在 chrome 扩展里跑，可以同时加 `@ext-tools` 提供的 5 个 chrome 特化工具：

```ts
import { createAgent, fetchGetTool } from '@core'
import { extensionTools, type ExtensionToolCtx, type ExtensionToolRpc } from '@ext-tools'

// 你提供 chrome 桥接的具体实现：
const rpc: ExtensionToolRpc = {
  domOp: (op, timeoutMs = 30_000) => myDomOpBridge(op, timeoutMs),
  chromeApi: (method, args) => myChromeApiBridge(method, args),
}

const toolContext: ExtensionToolCtx = {
  rpc,
  tabId,
  conversationId,
}

const agent = createAgent({
  llm: { apiKey, baseUrl, model },
  tools: [fetchGetTool, ...extensionTools],
  toolContext,
})
```

参考实现：`src/extension/offscreen.ts` 里的 `runChat()` 函数。

`extensionTools` 数组当前包含：
- `readPageTool` — 读当前页文本/markdown/html-simplified
- `readSelectionTool` — 读用户选中的文本
- `querySelectorTool` — 跑 CSS 选择器返回前 20 个匹配
- `screenshotTool` — 当前可视区截图（via `chrome.tabs.captureVisibleTab`）
- `listTabsTool` — 列出所有打开的 tab

工具运行时通过 `ctx.rpc.domOp(...)` 把请求广播给 content script（DOM 操作）或 service worker（chrome.\* 调用）；具体怎么路由由你的 `rpc` 实现决定。本仓的扩展用 `chrome.runtime.sendMessage` 做这件事。

---

## 5. AgentEvent：你能消费什么

`agent.send()` 产生 5 种事件，由 `src/agent-core/protocol.ts` 的 zod schema 守护：

| kind | 字段 | 含义 |
|---|---|---|
| `message/streamChunk` | `delta: string` | LLM 流式输出的下一段文本 |
| `tool/start` | `toolCall: { id, tool, args }` | 模型决定调一个工具，正在执行 |
| `tool/end` | `toolCallId: string`, `result: { ok: boolean, content: string }` | 工具返回；`content` 是 ToolResult 序列化后的 JSON 字符串 |
| `done` | `stopReason: 'end_turn' \| 'tool_use' \| 'max_iterations' \| 'cancel' \| 'error'`, `assistantText: string`, `error?: { code, message }` | 一轮 send 结束；`assistantText` 是该轮累计的全部 assistant 文本 |
| `fatalError` | `code: string`, `message: string` | 引擎不可恢复错误（**当前 AgentSession 不主动 emit**——保留给未来扩展，例如 sub-agent 故障）|

事件中**不**包含传输 envelope（id / sessionId / 时间戳）也**不**包含持久化 messageId——这些由消费方按自己的 transport 加。本仓的扩展实现见 `src/extension/offscreen.ts` 里的 `emit({ id: crypto.randomUUID(), sessionId, ts: Date.now(), ...wrappedEvent })`。

---

## 6. 多轮对话：传 history

agent-core 不持久化对话，只缓存当前 session 的内存历史。多轮场景由消费方负责装载 prior history 并通过 `send()` 第二参数传入：

```ts
const priorHistory: ChatMessage[] = (await loadFromStorage(conversationId))
  .map((m) => ({
    role: m.role === 'system-synth' ? 'system' : m.role,
    content: m.content,
  }))

for await (const ev of agent.send(userText, { history: priorHistory })) {
  // ...
}
```

`history` 只在 session 第一次 send 时生效（`AgentSession` 检测 `this.history.length === 0` 时注入），后续 send 用 session 内部累积的对话。**实际用法：每次 chat 起一个新 AgentSession + 用 history 注入**——这是本仓扩展的做法。

`ChatMessage` 类型从 `@core/OpenAICompatibleClient` 或 `@core` barrel 都可以导出：

```ts
import type { ChatMessage } from '@core'
```

---

## 7. 写一个新工具

工具分两类：

### 7a. agent-core 通用工具（`src/agent-core/tools/`）

只用浏览器原生 API（fetch、纯计算），跨任何浏览器上下文都能跑。模板：

```ts
// src/agent-core/tools/myTool.ts
import { makeOk, makeError } from '../Tool'
import type { ToolDefinition } from '../types'

interface Input { url: string }
interface Output { length: number }

export const myTool: ToolDefinition<Input, Output> = {
  name: 'myTool',
  description: 'compute byte length of a URL\'s body',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  async execute(input, _ctx) {
    try {
      const res = await fetch(input.url)
      const buf = await res.arrayBuffer()
      return makeOk({ length: buf.byteLength })
    } catch (e) {
      return makeError('fetch_failed', String(e), true)
    }
  },
}
```

记得在 `src/agent-core/index.ts` 里 export。

### 7b. 扩展特化工具（`src/extension-tools/tools/`）

需要 chrome.\* 或 DOM 操作。声明你需要的特化 ctx 字段（用 `ExtensionToolCtx` 即可），通过 `ctx.rpc.*` 调用胶水：

```ts
// src/extension-tools/tools/myDomTool.ts
import { makeError } from '@core/Tool'
import type { ToolDefinition } from '@core'
import type { ExtensionToolCtx } from '../ctx'

interface Input { selector: string }
interface Output { count: number }

export const myDomTool: ToolDefinition<Input, Output, ExtensionToolCtx> = {
  name: 'countMatches',
  description: 'count how many DOM nodes match a selector',
  inputSchema: {
    type: 'object',
    properties: { selector: { type: 'string' } },
    required: ['selector'],
  },
  async execute(input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', '...')
    return (await ctx.rpc.domOp(
      { kind: 'dom/querySelector', tabId: ctx.tabId, selector: input.selector, all: true },
      30_000,
    )) as any
  },
}
```

如果你的 op kind 是新的（`dom/myOp` 之类），要：
1. 在 `src/extension-tools/DomOp.ts` 的 zod 联合里加一支
2. 在 `src/extension-tools/content/domHandlers.ts` 加 handler 分支

加完之后在 `src/extension-tools/index.ts` 把 tool 加到 `extensionTools` 数组。

---

## 8. 注入特化 ctx：ExtraCtx 模式

`ToolDefinition` 的第三个泛型参数 `ExtraCtx` 让工具声明它需要的 ctx 字段类型；`createAgent` 的 `toolContext` 参数必须满足该类型。

```ts
type MyExtra = { auth: { userId: string; token: string } }

const myTool: ToolDefinition<Input, Output, MyExtra> = {
  name: 'callMyAPI',
  description: '...',
  inputSchema: { ... },
  async execute(input, ctx) {
    // ctx.auth is typed { userId, token }
    return fetch('/me', { headers: { Authorization: `Bearer ${ctx.auth.token}` } })
  },
}

const agent = createAgent<MyExtra>({
  llm: { ... },
  tools: [myTool],
  toolContext: { auth: { userId: 'u1', token: 't1' } },
})
```

异构数组：fetchGet（基础 ctx）+ 自带 ExtraCtx 的工具混合传入是合法的——`createAgent` 的 `tools` 参数类型放宽到 `Array<ToolDefinition<any, any, any>>`，编译器不阻止。运行时由 consumer 保证传入的 `toolContext` 满足"读它的工具"所需的字段。

---

## 9. 边界 & 测试

### 边界

- `src/agent-core/` 不能 import `chrome.*`、`@ext/*`、`@ext-tools/*`。
- `src/extension-tools/` 不能 import `@ext/*`（不依赖具体扩展运行时；只依赖 `@core`）。
- 这些规则由 TS project references 强制：`src/agent-core/tsconfig.json` 不加载 `@types/chrome`，违反就 typecheck 红。

### 自己测试新工具

把工具放到 `tests/...` 下，用 spy/stub mock 掉 `ctx.rpc`：

```ts
// tests/agent-core/myTool.test.ts
import { describe, it, expect, vi } from 'vitest'
import { myTool } from '@core/tools/myTool'

describe('myTool', () => {
  it('returns byte length', async () => {
    globalThis.fetch = vi.fn(async () => new Response('hello')) as any
    const result = await myTool.execute({ url: 'http://x' }, { signal: undefined })
    expect(result.ok).toBe(true)
    expect((result as any).data.length).toBe(5)
  })
})
```

`tests/tools/readPage.test.ts` 是扩展工具测试的范例，可以照抄。

---

## 10. 常见坑

- **`agent.send()` 不返回值；它返回 AsyncIterable**。要消费才有效果。
- **多次调 `send` 会累积内部 history**。如果你想要"每次干净对话"，每次 chat 创建新 `AgentSession`（本仓扩展就这么做的）。
- **`ChatMessage` 的 role 不能是 `system-synth`**——OpenAI 不认。从持久化加载 history 时记得映射回 `'system'`。
- **`ToolResult.data`** 在 wire 上是 `JSON.stringify` 后的字符串塞进 `tool/end.result.content`；如果你的工具返回 `string`，会被原样传过；返回对象会被 stringify。LLM 看到的就是这个字符串。
- **Abort 会让 LLM fetch 抛 DOMException**，QueryEngine catch 后 yield `{ kind: 'done', stopReason: 'error', error: { code: 'llm_error', ... } }`——不是 `'cancel'`。这是已知行为；spec §10 留了 open question。

---

## 11. 公开 API 参考（barrel）

`@core` 默认导出（来自 `src/agent-core/index.ts`）：

```ts
// 工厂 + session
createAgent(opts) → AgentSession
class AgentSession { send(text, opts?) cancel() }
type CreateAgentOptions

// LLM client（如要直接用）
class OpenAICompatibleClient { streamChat(req) }
type ChatMessage, StreamEvent

// 引擎（如要直接用，不推荐——createAgent 已封装）
class QueryEngine
type EngineEvent

// 工具协议
class ToolRegistry
type ToolDefinition, ToolExecContext, ToolResult, ToolCall
toOpenAiTool, makeOk, makeError

// 通用工具
fetchGetTool

// 协议（事件流 schema）
AgentEvent  // zod schema + 推断类型

// ID/类型
type Uuid, ConversationId, MessageId, ToolCallId, SkillId, ApprovalId, Role
type Message, UserMessage, AssistantMessage, ToolMessage, ContentPart
```

`@ext-tools` 默认导出（来自 `src/extension-tools/index.ts`）：

```ts
extensionTools  // 5 个 chrome 工具的数组
type ExtensionToolCtx, ExtensionToolRpc
DomOp  // zod schema for content-script 协议
readPageTool, readSelectionTool, querySelectorTool, screenshotTool, listTabsTool
```

`@ext-tools/content/domHandlers`：

```ts
installDomHandlers()  // 在 content script 启动时调一次
```
