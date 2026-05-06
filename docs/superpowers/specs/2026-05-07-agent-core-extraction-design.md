---
name: agent-core 内部模块抽取与边界守卫
date: 2026-05-07
status: draft
source: 与用户的 brainstorm 会话
---

# agent-core 内部模块抽取与边界守卫

## 1. 我们在做什么

把当前散落在 `src/agent/`、`src/tools/`、`src/shared/types.ts`、`src/extension/rpc/protocol.ts`
里的"agent 引擎 + 协议"代码收敛到一个内部模块 `src/agent-core/`，并把 chrome 扩展特化的工具抽到
`src/extension-tools/`。两个模块都**仍然住在本仓的同一个 npm package 里**，不发布、不开 workspace；
它们对外（对扩展入口代码）暴露的是稳定的工厂函数 `createAgent({ llm, tools, toolContext })` 和
配套类型。chrome 运行时胶水（runtime.Port、IndexedDB、UI、setting 加载）继续留在 `src/extension/`
里，作为 agent-core 的第一个——目前唯一一个——consumer。

边界用 TypeScript project references 强制：`agent-core/tsconfig.json` 不加载 `@types/chrome`，
任何 `chrome.xxx` 引用 typecheck 直接红，无需 lint 规则或 review 把关。

## 2. 目标与非目标

### 目标
- 把 `QueryEngine` / `OpenAICompatibleClient` / `ToolRegistry` / agent 类型 / `AgentEvent` schema
  从 chrome 假设里彻底剥离，迁入 `src/agent-core/`。
- 提供一个**单一对外入口** `createAgent`，接受 `{ llm, tools, toolContext }`，返回
  `AgentSession`（`send(text) → AsyncIterable<AgentEvent>`、`cancel()`）。
- 把当前 `ToolExecContext` 里 chrome 特化的字段（`tabId`、`rpc.domOp`、`rpc.chromeApi`）从核心
  类型剥掉。`agent-core` 提供泛型化的 `ToolDefinition<I, O, ExtraCtx>`，扩展工具特化为
  `ToolDefinition<I, O, ExtensionToolCtx>`，`ExtensionToolCtx` 把 `rpc` / `tabId` 这些字段定义
  在 `extension-tools` 里。
- 把扩展工具（`readPage` / `readSelection` / `querySelector` / `screenshot` / `listTabs`）连同
  `DomOp` Zod schema、content-script handler kit、扩展工具特化的 ctx 类型（`ExtensionToolCtx`）
  整体迁入 `src/extension-tools/`。
- 通过 TypeScript project references 让 typecheck 强制执行"`agent-core` 不依赖 chrome / 扩展工具
  / 扩展运行时"。

### 非目标
- 不发布 npm 包，不开 bun/pnpm workspace。`src/agent-core/` 与 `src/extension-tools/` 物理上仍在
  本仓的同一个 `package.json` 下。
- 不引入新依赖，不改 LLM provider（OpenAI-compatible 仍是唯一）。
- 不重写持久化。`IndexedDB`、`chrome.storage.local`、settings 加载继续留在
  `src/extension/storage/`，agent-core 不感知它们。
- 不改运行时拓扑：四进程边界（content / SW / offscreen / sandbox）以及两种传输（长连接 port +
  one-shot sendMessage）保持原样。
- 不为"将来抽 CLI / Node / Playwright" 做任何额外抽象。本次抽取**只服务于 web/扩展**。
- 不动 UI 组件、settings 表单、Plan A 与 Plan B 已落地的功能行为。

### 显式不做（YAGNI 提醒）
- 不引入 `BrowserBackend` 这种"为换 Playwright 留口子"的接口层。扩展工具直接复用现有的
  `rpc.domOp` / `rpc.chromeApi` 回调，只是把对应类型从 chrome 上下文里剥离搬到
  `extension-tools/`。要换执行环境是未来另立 spec 的事。
- 不做事件流的二次封装（什么 `EventEmitter`、`Observable`）。`AsyncIterable<AgentEvent>` 已经够用。

## 3. 仓库与模块布局

```
mycli-web/                            ← 仍是单 package.json、单 git repo
├── package.json
├── tsconfig.base.json                ← 共用 compilerOptions
├── tsconfig.json                     ← references: [agent-core, extension-tools, extension]
├── src/
│   ├── agent-core/
│   │   ├── tsconfig.json             ← types: ["vite/client"]，**不**含 "chrome"
│   │   ├── index.ts                  ← 唯一对外 barrel
│   │   ├── createAgent.ts            ← 工厂；装配 client + registry + engine
│   │   ├── AgentSession.ts           ← send / cancel；EngineEvent → AgentEvent 翻译
│   │   ├── QueryEngine.ts            ← 从 src/agent/query/QueryEngine.ts 搬
│   │   ├── OpenAICompatibleClient.ts ← 从 src/agent/api/openaiCompatibleClient.ts 搬
│   │   ├── ToolRegistry.ts           ← 从 src/tools/registry.ts 搬
│   │   ├── Tool.ts                   ← 从 src/agent/Tool.ts 搬（toOpenAiTool / makeError）
│   │   ├── types.ts                  ← ToolDefinition / ToolResult / 干净版 ToolExecContext
│   │   ├── protocol.ts               ← AgentEvent Zod schema（不含 ClientCmd / DomOp）
│   │   └── tools/
│   │       └── fetchGet.ts           ← 从 src/tools/fetchGet.ts 搬，0 改动
│   │
│   ├── extension-tools/
│   │   ├── tsconfig.json             ← types: ["chrome", "vite/client"]
│   │   │                              ← references: [../agent-core/tsconfig.json]
│   │   ├── index.ts                  ← export { extensionTools, ExtensionToolCtx, DomOp, ... }
│   │   ├── ctx.ts                    ← ExtensionToolCtx 类型（rpc.domOp / rpc.chromeApi / tabId）
│   │   ├── DomOp.ts                  ← Zod schema（从 extension/rpc/protocol.ts 抽出）
│   │   ├── tools/
│   │   │   ├── readPage.ts
│   │   │   ├── readSelection.ts
│   │   │   ├── querySelector.ts
│   │   │   ├── screenshot.ts
│   │   │   └── listTabs.ts
│   │   └── content/
│   │       └── domHandlers.ts        ← 从 src/extension/content/domHandlers.ts 搬
│   │
│   └── extension/
│       ├── tsconfig.json             ← types: ["chrome", "vite/client"]
│       │                              ← references: [../agent-core, ../extension-tools]
│       ├── background.ts             ← chrome.runtime / chrome.commands 路由
│       ├── offscreen.ts              ← createAgent + chrome backend 实现
│       ├── content/                  ← Shadow DOM UI；import domHandlers from @ext-tools
│       ├── ui/                       ← React 组件
│       ├── options/                  ← 选项页
│       ├── storage/                  ← IDB + chrome.storage 包装
│       └── rpc/
│           ├── ClientCmd.ts          ← chrome port 传输 schema（留扩展，不进 agent-core）
│           ├── hub.ts                ← port 路由
│           └── transport.ts          ← sendDomOp / callChromeApi 实现
│
├── tests/                            ← 按上面三层组织
└── vite.config.ts                    ← path alias 同步
```

### 模块依赖图

```
┌─────────────────────────────────────────────────┐
│             src/agent-core/                     │
│   引擎 + 协议 + 类型 + 通用工具(fetchGet)         │
│   不知道 chrome、不知道 extension-tools          │
└─────────────────────────────────────────────────┘
                  ▲                ▲
                  │                │
                  │                │
┌─────────────────┴────┐     ┌─────┴───────────────┐
│ src/extension-tools/ │     │   src/extension/    │
│ chrome 特化工具 +     │◄────│  chrome 运行时入口   │
│ ExtensionToolCtx +   │     │  + UI + IDB + RPC   │
│ DomOp + handlers     │     │  + createAgent 装配 │
└──────────────────────┘     └─────────────────────┘
```

## 4. 公开 API（agent-core 对外面）

> 本节描述的是**完成 PR 2 之后**的最终形态。中间态见 §8。

### `createAgent`

```ts
// src/agent-core/createAgent.ts
import type { ToolDefinition } from './types'

export interface CreateAgentOptions<ExtraCtx = Record<string, never>> {
  llm: { apiKey: string; baseUrl: string; model: string }
  tools: ToolDefinition<any, any, ExtraCtx>[]
  toolContext: ExtraCtx                     // ← consumer 注入特化字段（如 backend、tabId）
  systemPrompt?: string
  toolMaxIterations?: number
  signal?: AbortSignal
}

export function createAgent<ExtraCtx>(opts: CreateAgentOptions<ExtraCtx>): AgentSession
```

### `AgentSession`

```ts
export interface AgentSession {
  send(text: string, opts?: { history?: ChatMessage[] }): AsyncIterable<AgentEvent>
  cancel(): void
}
```

`AgentEvent` 是从 EngineEvent 翻译过来的对外事件流（`message/streamChunk`、`tool/start`、
`tool/end`、`message/appended`、`done`、`fatalError`），定义在 `agent-core/protocol.ts`，由 Zod
schema 守护。consumer 可以直接 emit 它们到任何 transport（chrome port、SSE、postMessage 都行）。

`ChatMessage` 类型从 `agent-core/OpenAICompatibleClient.ts` 重新导出（同名字段：role/content/
tool_calls/...），是 OpenAI wire 形状的薄封装。consumer 不必直接构造它——`AgentSession.send()`
内部会从历史消息生成。

### `ToolDefinition`（变更：泛型化第三参数）

```ts
// src/agent-core/types.ts
export interface ToolExecContext {
  signal?: AbortSignal
}

export interface ToolDefinition<I = unknown, O = unknown, ExtraCtx = Record<string, never>> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: I, ctx: ToolExecContext & ExtraCtx): Promise<ToolResult<O>>
}
```

`ToolExecContext` 基类只保留 `signal`，不带任何业务字段。`conversationId`、`tabId`、`backend`
都属于 consumer 关心的特化字段，统一通过 `ExtraCtx` 注入——`agent-core` 不假设 conversation 概
念存在（毕竟 IDB 持久化也不归它管）。

旧的 `tabId` 字段、`rpc.domOp` / `rpc.chromeApi` 从这里删除。`exec: 'content'|'sw'|'offscreen'`
也删除——执行位置已经由"工具来自哪个包"隐含决定（`agent-core` 工具在 offscreen 跑，
`extension-tools` 工具通过 backend 转发到 SW/content）。

### `ToolRegistry`（不泛型化）

`ToolRegistry` 内部以 `ToolDefinition<any, any, any>` 存储，不参数化。类型校验发生在
`createAgent<ExtraCtx>` 这一层：传入的 `tools` 数组要求第三参数与 `toolContext` 类型一致，
TypeScript 在调用点校验。registry 只是个 name → def 的 map，不需要类型门面。

### `ExtensionToolCtx`（在 extension-tools）

```ts
// src/extension-tools/ctx.ts
import type { ToolResult } from '@core'

export interface ExtensionToolRpc {
  /** 把一个 DomOp envelope 发到目标 tab 的 content script，返回工具结果 */
  domOp(op: unknown, timeoutMs?: number): Promise<ToolResult>
  /** 通过 SW 调一个 chrome.* 方法 */
  chromeApi(method: string, args: unknown[]): Promise<ToolResult>
}

export interface ExtensionToolCtx {
  rpc: ExtensionToolRpc
  tabId?: number
  conversationId?: ConversationId  // 给将来需要按会话隔离的工具用；当前没有工具读它
}
```

形态与现在 `ToolExecRpc` 完全一致——这是有意的：本次抽取**只搬位置**，不引入新抽象。
扩展的 `offscreen.ts` 继续提供 `domOp` / `chromeApi` 的具体实现（`sendDomOp` / `callChromeApi`
现有代码原地不动），通过 `toolContext: { rpc: { domOp, chromeApi }, tabId, conversationId }`
注入。

extension-tools 的 barrel 导出一个 `extensionTools: ToolDefinition<any, any, ExtensionToolCtx>[]`
数组，方便 consumer 一次性传入：

```ts
// src/extension-tools/index.ts
export const extensionTools = [
  readPageTool, readSelectionTool, querySelectorTool,
  screenshotTool, listTabsTool,
]
```

扩展工具就是 `ToolDefinition<I, O, ExtensionToolCtx>`：

```ts
// src/extension-tools/tools/readPage.ts
export const readPageTool: ToolDefinition<ReadPageInput, ReadPageOutput, ExtensionToolCtx> = {
  name: 'readPage',
  description: '...',
  inputSchema: {...},
  async execute(input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', '...')
    return ctx.backend.readPage(ctx.tabId, input.mode ?? 'text')
  },
}
```

## 5. 数据流（用户消息一次往返）

```
[Content Script UI]
  │  user types "帮我..."
  │  RpcClient.send(ClientCmd: chat/send)
  ▼
[Service Worker hub]                     ← src/extension/rpc/hub.ts
  │  forwards on sw-to-offscreen port
  ▼
[Offscreen runChat()]                    ← src/extension/offscreen.ts
  │  loadSettings(), appendMessage(IDB)
  │  call createAgent({
  │      llm,
  │      tools: [fetchGetTool, ...extensionTools],     // fetchGetTool from @core
  │      toolContext: {
  │        rpc: { domOp: sendDomOp, chromeApi: callChromeApi },
  │        tabId, conversationId,
  │      },
  │  })
  │  for await (ev of agent.send(text)) emit(translateToWireEvent(ev))
  ▼
[agent-core AgentSession.send]
  │  QueryEngine.run(history)
  │  ├─ stream LLM ──→ 'assistant_delta'
  │  ├─ tool_calls ──→ executeTool(call) → registry.get(name).execute(input, ctx)
  │  │                                       │
  │  │                                       ▼
  │  │                          [extension-tools readPage.execute]
  │  │                            ctx.rpc.domOp({ kind: 'dom/readPage', tabId, mode })
  │  │                                       │
  │  │                                       ▼
  │  │                          [sendDomOp in offscreen]
  │  │                            chrome.runtime.sendMessage broadcast
  │  │                                       │
  │  │                                       ▼
  │  │                          [Content Script domHandlers]
  │  │                            DomOp.parse(msg.op) → handler → return result
  │  └─ ToolResult → push to history → next LLM iteration
  ▼
AgentEvent stream → Offscreen emits → SW port → Content Script UI renders
```

`agent-core` 完全不知道这条链上有 chrome——它只看到 `tools.execute(input, ctx)` 这个抽象，
`ctx` 的具体形状由 consumer 通过 `ExtraCtx` 决定。反过来，content script、SW、IDB 也完全不
知道 agent-core 内部是怎么循环的，它们只看 `ClientCmd`/`AgentEvent` 这两组 wire schema。

## 6. 边界守卫：TypeScript project references

`tsconfig.base.json`：共用 compiler 选项。
`src/agent-core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../../dist-types/agent-core",
    "types": ["vite/client"]                   /* 注意：没有 "chrome" */
  },
  "include": ["**/*.ts"]
}
```

`src/extension-tools/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "types": ["chrome", "vite/client"]
  },
  "references": [{ "path": "../agent-core" }],
  "include": ["**/*.ts"]
}
```

`src/extension/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "types": ["chrome", "vite/client"]
  },
  "references": [
    { "path": "../agent-core" },
    { "path": "../extension-tools" }
  ],
  "include": ["**/*.ts", "**/*.tsx"]
}
```

顶层 `tsconfig.json`：仅做 references 聚合，`bun run typecheck` 改成 `tsc -b`（build mode）。

### Path alias

`tsconfig.base.json` 与 `vite.config.ts`、`vitest.config.ts` 同步加：

| alias       | 路径                          |
|-------------|-------------------------------|
| `@core`     | `src/agent-core/index.ts`     |
| `@core/*`   | `src/agent-core/*`            |
| `@ext-tools`| `src/extension-tools/index.ts`|
| `@ext-tools/*` | `src/extension-tools/*`    |
| `@ext/*`    | `src/extension/*`（保留）     |

`@shared/*` 退役：当前 `src/shared/types.ts` 里的 agent 类型搬到 `agent-core/types.ts`，没有别的
内容会留下。

### 守卫起作用的方式

- `agent-core/` 任何文件写 `chrome.runtime.xxx` → typecheck 报 `Cannot find name 'chrome'`。
- `agent-core/` 任何文件写 `import x from '@ext-tools'` → tsc 在 references 不合法时报错（agent-core
  没把 extension-tools 加为 reference）。
- 反向（extension-tools 用 agent-core）合法，因为 references 配了。

## 7. ClientCmd 的去向

当前 `src/extension/rpc/protocol.ts` 同时定义了 `ClientCmd`（client → agent）、`AgentEvent`（agent
→ client）、`DomOp`（offscreen ↔ content）。三者用途不同：

- `AgentEvent` 是 agent 对外吐的事件流，**搬入 `agent-core/protocol.ts`**。
- `DomOp` 只在 chrome content script 之间流转，**搬入 `extension-tools/DomOp.ts`**。
- `ClientCmd` 包含 `sessionId`、`approval/reply`、`skill/setEnabled` 等传输/扩展层关注的字段，
  本质是"chrome runtime port 的 wire schema"，**留在 `src/extension/rpc/ClientCmd.ts`**，不进
  agent-core。`createAgent` 的 API 是 `agent.send(text)`，不接受 `ClientCmd`——是 `offscreen.ts` 在
  收到 `chat/send` 后调 `agent.send(cmd.text)`。

这条划分让"agent 核心 API"和"扩展 wire 协议"解耦：将来 wire 加新 kind（比如 attachments
metadata），不动 agent-core；agent-core 加新 event（比如 `subAgent/...`），wire schema 也不动。

## 8. 迁移：两步 PR

### PR 1 — agent-core 抽取 + 工厂封装

**搬家**
- `src/agent/query/QueryEngine.ts` → `src/agent-core/QueryEngine.ts`
- `src/agent/query/tokenBudget.ts` → `src/agent-core/tokenBudget.ts`
- `src/agent/api/openaiCompatibleClient.ts` → `src/agent-core/OpenAICompatibleClient.ts`
- `src/agent/Tool.ts` → `src/agent-core/Tool.ts`
- `src/tools/registry.ts` → `src/agent-core/ToolRegistry.ts`
- `src/tools/fetchGet.ts` → `src/agent-core/tools/fetchGet.ts`
- `src/shared/types.ts` 里 agent 相关类型 → `src/agent-core/types.ts`（**保留旧字段**：`tabId`、
  `rpc`、`exec` 暂不删，让旧扩展工具继续工作；标记 `@deprecated`）
- `src/extension/rpc/protocol.ts` 里 `AgentEvent` 部分 → `src/agent-core/protocol.ts`

**新增**
- `src/agent-core/createAgent.ts` + `AgentSession.ts` — 把 offscreen 里现有的 engine 装配代码搬进
  来；`offscreen.ts` 改成调 `createAgent`
- `src/agent-core/index.ts` barrel
- `src/agent-core/tsconfig.json`、顶层 `tsconfig.json` 改 build mode
- `vite.config.ts` / `vitest.config.ts` 加 `@core` 别名
- 顶层 `package.json` 的 `typecheck` 改成 `tsc -b`

**保持不变**
- `src/tools/{readPage,readSelection,querySelector,screenshot,listTabs}.ts` 仍在原位，仍走旧
  `ctx.rpc.domOp/chromeApi` 路径——它们是 PR 2 的活。
- `src/extension/content/domHandlers.ts` 不动。
- `src/extension/rpc/protocol.ts` 里 `ClientCmd` 与 `DomOp` 不动。

**验收**
- 扩展能 build、能 chat、能调用 `fetchGet`、`readPage` 等所有现有工具，行为与 main 完全一致。
- `tsc -b` 通过；`vitest run` 通过。
- `src/agent-core/` 目录下 grep `chrome\.` 零结果。

**风险**
- 类型重复：旧 `ToolExecContext` 还含 `tabId/rpc/exec`，新版本里加了 `signal`、泛型 `ExtraCtx`。
  做法：让新 `ToolExecContext` 兼容旧字段（标记 deprecated），PR 2 再清。

### PR 2 — extension-tools 抽取 + ToolExecContext 清理

**搬家**
- `src/tools/{readPage,readSelection,querySelector,screenshot,listTabs}.ts` →
  `src/extension-tools/tools/`
- `src/extension/rpc/protocol.ts` 里 `DomOp` schema → `src/extension-tools/DomOp.ts`
- `src/extension/content/domHandlers.ts` → `src/extension-tools/content/domHandlers.ts`，扩展
  content script 改 import

**新增**
- `src/extension-tools/ctx.ts` — `ExtensionToolCtx` / `ExtensionToolRpc` 类型（即 `ToolExecRpc`
  从 `src/shared/types.ts` 搬来后改名 + 加 `tabId` / `conversationId`）
- `src/extension-tools/tsconfig.json`
- `src/extension-tools/index.ts` barrel：`export { extensionTools, ExtensionToolCtx, ExtensionToolRpc, DomOp, ... }`
- `vite.config.ts` / `vitest.config.ts` 加 `@ext-tools` 别名

**改造**
- 扩展工具的 `execute(input, ctx)` 签名改成 `ToolDefinition<I, O, ExtensionToolCtx>`；函数体内
  继续用 `ctx.rpc.domOp(...)` 和 `ctx.rpc.chromeApi(...)`，与目前一字不差。
- `src/extension/offscreen.ts` 把现有的 `sendDomOp` / `callChromeApi` 函数原地保留（它们
  本来就是 chrome 胶水），调 `createAgent` 时传 `toolContext: { rpc: { domOp: sendDomOp,
  chromeApi: callChromeApi }, tabId, conversationId }`。
- `agent-core/types.ts` 里 `ToolExecContext` 删除 `tabId` / `rpc` / `exec` 字段（兼容窗口结束）。
- `src/extension/content/domHandlers.ts` 物理迁到 `src/extension-tools/content/`，扩展 content
  script 改 import 路径（manifest 不需要改）。

**验收**
- 同 PR 1 加上：`src/extension-tools/` 不 import `chrome.runtime.sendMessage`（运行时胶水仍在
  `src/extension/offscreen.ts`）；`src/agent-core/` 仍然 zero chrome。
- 现有所有工具类相关测试不变更预期，全部通过。

**风险**
- content-script 注入路径变更（`domHandlers` 现在来自 `@ext-tools`），manifest 不需要改但 import
  路径要全量替换。
- 类型变更面较小（只是 ctx 多了泛型参数 + 某些字段移位），review 时主要看 import 路径和
  `toolContext` 注入是否完整。

## 9. 测试策略

- `agent-core` 的测试在 `tests/agent-core/`，**只用 jsdom + 假 fetch**（不 mock chrome.*）。
  目的：确保任何走进 chrome API 的代码都进不来这一层——测试时根本没有 chrome 这个全局。
  从 `tests/setup.ts` 抽一个不装 chrome mock 的子环境。
- `extension-tools` 的测试在 `tests/extension-tools/`，需要 chrome.* mock（沿用现有
  `tests/setup.ts`）；`ExtensionToolRpc` 的 `domOp` / `chromeApi` 用 spy/stub 替代，验证工具
  发出的 envelope 形状（`{ kind: 'dom/readPage', tabId, mode }` 等）。
- `extension/` 的测试维持现状（端口路由、IDB、UI 集成）。
- 现有 `tests/rpc/hub.test.ts`、`tests/storage/*.test.ts` 不动。

## 10. 已知风险与开放问题

- **`OpenAICompatibleClient` 的 fetch 兼容**：当前实现用 `fetch` + `ReadableStream` + `TextDecoder`，
  这些在所有目标 chromium 浏览器都有。`agent-core` 不兜底 Node fetch 差异（也不需要——非目标）。
- **`crypto.randomUUID()`**：`OpenAICompatibleClient` 和 `QueryEngine` 都用它，所有 chromium
  目标版本支持，不需要 polyfill。
- **`compaction` / `stopHooks` / 子 agent**：当前 `Plan B` 还没实装这些，spec 也不预占位置。
  将来加时如果发现 ctx 还需要新字段，扩展 `CreateAgentOptions` 就行。
- **多 conversation 并发**：当前 `activeAborts` 在 offscreen 里以 `sessionId` 索引，同时只跑一个
  会话。如果未来要并发，`AgentSession` 是天然的并发单元（每个 session 自带 abort），但这次不
  额外抽。
- **`Tool.ts` 里 `toOpenAiTool`**：依赖 `inputSchema`，未来如果要支持非 OpenAI 的 schema 形式
  （例如 Anthropic 风格），这里要改。本次保持原样。
