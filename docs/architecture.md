# mycli-web 架构总览（2026-05-07 抽核之后）

本文档描述 `mycli-web` Chrome MV3 扩展 + agent 内部模块在 PR 1 + PR 2 抽核之后的整体结构。读完后你应该能回答：

- 哪份代码住在哪个目录、为什么
- 一条用户消息从输入到 LLM 再回 UI 走过哪几个进程边界
- 边界守卫是怎么实现的
- 想加新功能（工具 / chat surface / 持久化字段）该改哪里

> 历史决策见 `docs/superpowers/specs/2026-04-24-mycli-web-design.md`（原始设计）和 `docs/superpowers/specs/2026-05-07-agent-core-extraction-design.md`（抽核设计）。

---

## 1. 三层模块布局

仓内是单一 npm package（**不发布**），但内部目录用 TypeScript project references 拆成三个子项目：

```
mycli-web/
├── package.json                       ← 单 package；bun workspace 没启用
├── tsconfig.base.json                 ← 共享 compiler options + path 别名
├── tsconfig.json                      ← 顶层只做 references 聚合
├── src/
│   ├── agent-core/                    ← 第一层：引擎 + 协议（环境无关）
│   │   ├── tsconfig.json              ←   types: ["vite/client"] —— 没有 "chrome"
│   │   ├── index.ts                   ← public barrel：createAgent、types
│   │   ├── createAgent.ts             ← 工厂；接受 { llm, tools, toolContext }
│   │   ├── AgentSession.ts            ← engine.run() + AbortController + 事件翻译
│   │   ├── QueryEngine.ts             ← LLM ↔ 工具循环
│   │   ├── OpenAICompatibleClient.ts  ← SSE 流式 chat completions
│   │   ├── ToolRegistry.ts            ← name → ToolDefinition 映射
│   │   ├── Tool.ts                    ← toOpenAiTool / makeOk / makeError 助手
│   │   ├── tokenBudget.ts             ← token 估算
│   │   ├── types.ts                   ← ToolDefinition / ToolResult / ID 类型
│   │   ├── protocol.ts                ← AgentEvent Zod schema（无 envelope）
│   │   └── tools/
│   │       └── fetchGet.ts            ← 唯一一个跨环境工具（只用 fetch）
│   │
│   ├── extension-tools/               ← 第二层：浏览器特化工具（Chrome MV3）
│   │   ├── tsconfig.json              ←   types: ["chrome", "vite/client"]
│   │   ├── index.ts                   ← barrel：extensionTools 数组 + 类型
│   │   ├── ctx.ts                     ← ExtensionToolCtx + ExtensionToolRpc
│   │   ├── DomOp.ts                   ← content-script wire schema
│   │   ├── tools/
│   │   │   ├── readPage.ts            ← DOM 读取（text/markdown/html）
│   │   │   ├── readSelection.ts       ← 用户选区
│   │   │   ├── querySelector.ts       ← CSS 选择器
│   │   │   ├── screenshot.ts          ← chrome.tabs.captureVisibleTab
│   │   │   └── listTabs.ts            ← chrome.tabs.query
│   │   └── content/
│   │       └── domHandlers.ts         ← installDomHandlers() — content script 入口处调一次
│   │
│   └── extension/                     ← 第三层：扩展运行时（chrome 胶水 + UI + IDB）
│       ├── tsconfig.json              ←   refs: agent-core, extension-tools
│       ├── background.ts              ← service worker：RPC 路由、chrome.* 代理
│       ├── offscreen.ts               ← agent 装配点：createAgent + Chrome backend
│       ├── content/                   ← content script + Shadow DOM React UI
│       │   ├── index.tsx              ← content 入口（installDomHandlers + UI）
│       │   ├── ChatApp.tsx            ← chat window
│       │   └── fab.tsx                ← FAB 按钮
│       ├── ui/                        ← presentational React components
│       ├── options/                   ← options page entry
│       ├── storage/                   ← IDB + chrome.storage 包装
│       │   ├── db.ts                  ← versioned IDB schema
│       │   ├── conversations.ts
│       │   ├── messages.ts
│       │   ├── settings.ts            ← chrome.storage.local + zod 校验
│       │   ├── rules.ts               ← 审批规则（chrome.storage.local）
│       │   ├── transient.ts           ← chrome.storage.session
│       │   └── ...
│       └── rpc/
│           ├── protocol.ts            ← ClientCmd + AgentEvent wire schema（含 envelope）
│           ├── hub.ts                 ← chrome.runtime.Port 路由（content ↔ SW ↔ offscreen）
│           └── client.ts              ← content 侧 RpcClient
├── tests/
│   ├── tsconfig.json                  ← refs: agent-core, extension-tools, extension
│   ├── agent-core/                    ← createAgent + AgentSession 单测
│   ├── agent/                         ← QueryEngine / OpenAICompatibleClient / tokenBudget
│   ├── tools/                         ← fetchGet, registry, readPage
│   ├── rpc/                           ← hub, hub-forward
│   ├── storage/                       ← 各 IDB / chrome.storage 包装
│   ├── protocol.test.ts
│   └── setup.ts                       ← fake-indexeddb + chrome mock
├── docs/
│   ├── agent-core-usage.md            ← 接入文档（这文件相邻）
│   ├── architecture.md                ← 本文
│   └── superpowers/
│       ├── specs/                     ← 设计文档
│       └── plans/                     ← 实施计划
└── manifest.json                      ← MV3 manifest
```

### 三层依赖方向（单向）

```
extension/  ──→  extension-tools/  ──→  agent-core/
       ↘                                      ↗
        ─────────────  agent-core/  ─────────
```

具体：
- `extension/` 知道 `extension-tools/` 和 `agent-core/`
- `extension-tools/` 知道 `agent-core/`，**不**知道 `extension/`
- `agent-core/` 谁都不知道——它就是个被消费的库

---

## 2. 边界守卫：靠 TS project references 强制

每个目录有自己的 `tsconfig.json`，关键差异在 `compilerOptions.types`：

| 目录 | `types` | 含义 |
|---|---|---|
| `src/agent-core/` | `["vite/client"]` | 没有 `"chrome"` —— 写 `chrome.runtime.xxx` 直接 typecheck 红 |
| `src/extension-tools/` | `["chrome", "vite/client"]` | 工具实现层；可以用 chrome.\* |
| `src/extension/` | `["chrome", "vite/client"]` | 扩展运行时；当然要 chrome.\* |
| `tests/` | `["chrome", "vite/client", "vitest/globals"]` | 测试要 mock chrome 所以也加 |

`tsc -b` 跑顶层 `tsconfig.json` 时，每个子项目独立编译；上面那张 references 图就是从子项目的 `references` 字段拼出来的。验证零违规：

```bash
grep -rn 'chrome\.' src/agent-core --include='*.ts' && echo FAIL || echo OK
grep -rn "from '@ext\b\|from '@ext-tools" src/agent-core --include='*.ts' && echo FAIL || echo OK
grep -rn "from '@ext'" src/extension-tools --include='*.ts' && echo FAIL || echo OK
```

三道都应输出 `OK`。

### 路径别名（`tsconfig.base.json` + vite/vitest 同步）

| alias | 指向 |
|---|---|
| `@/*` | `./src/*` |
| `@ext/*` | `./src/extension/*` |
| `@core` | `./src/agent-core/index.ts`（barrel） |
| `@core/*` | `./src/agent-core/*` |
| `@ext-tools` | `./src/extension-tools/index.ts`（barrel） |
| `@ext-tools/*` | `./src/extension-tools/*` |

> Vite alias 是前缀匹配，所以两条 `@core` 同时存在：bare `@core` 解到 `index.ts`，`@core/Tool` 解到 `Tool.ts`。

`@shared` 别名已退役——agent 类型住在 `@core`。

---

## 3. 进程边界 / 运行时拓扑

扩展跑在四类 chrome 进程里，靠 message-passing 通信。**不会**共享内存。

| 进程 | 实例数 | 文件 | 职责 | 不做 |
|---|---|---|---|---|
| Content Script | 每个用户 tab 一个 | `src/extension/content/` | Shadow-DOM React UI（chat window + FAB），DOM 操作 | agent 状态、LLM 调用 |
| Service Worker | ≤ 1，事件驱动易休眠 | `src/extension/background.ts` | RPC 路由、`chrome.*` 代理、offscreen 生命周期、`chrome.commands` 快捷键 | 跑 agent 循环、长期状态 |
| Offscreen Document | ≤ 1，按需创建并保活 | `src/extension/offscreen.ts` | **agent 装配点**：调 `createAgent`、跑 LLM 循环、IDB 读写、emit AgentEvent 到 SW | DOM 操作（在用户页面）、UI 渲染 |
| Sandbox Iframe（未实装） | 每个代码型 skill 一个 | （未来） | 在 null-origin sandbox 跑 skill `tools.js` | 访问 chrome.\*、扩展 storage |

### 两套传输（看清楚是哪条）

1. **长连接 ports（chat 主路）**：`RpcClient` 在 content 端 `chrome.runtime.connect({ name: 'session' })`，SW 的 `installHub`（`src/extension/rpc/hub.ts`）接，再开一条 `name: 'sw-to-offscreen'` 转发到 offscreen。Port 上的所有消息走 Zod 校验（schema 在 `src/extension/rpc/protocol.ts`：`ClientCmd` + `AgentEvent`）。
2. **One-shot `chrome.runtime.sendMessage` 广播（工具副路）**：offscreen 的工具通过 `ctx.rpc.domOp(...)` / `ctx.rpc.chromeApi(...)` 广播请求；SW (`background.ts`) 或 content (`domHandlers.ts`) 收到后处理并广播 result，offscreen 用 random `id` 关联回应。**不**走 Zod 校验——保持 payload 跟现有 handler 一致。

---

## 4. 一条用户消息的完整旅程

```
[Content UI: ChatApp]
  user 输入 "读 X 网站标题"
  RpcClient.send({ kind: 'chat/send', text, sessionId })
       │  port 'session'
       ▼
[Service Worker: installHub]
  Zod 校验 ClientCmd
  转发到 offscreen (port 'sw-to-offscreen')
       │
       ▼
[Offscreen: handleClientCmd / runChat]
  loadSettings()                        // chrome.storage
  appendMessage(user)                   // IDB
  emit('message/appended' user msg)     // wire ← 加 envelope
  priorHistory = listMessagesByConversation(cid)  // IDB
  
  // ★ 装配 agent ★
  agent = createAgent({
    llm: { apiKey, baseUrl, model },
    tools: [fetchGetTool, ...extensionTools],
    toolContext: { rpc: { domOp, chromeApi }, tabId, conversationId },
  })
  
  for await (ev of agent.send(text, { history: priorHistory })) {
    ┌─────────────────────────────────────────────────────────┐
    │  [agent-core: AgentSession.send]                        │
    │     QueryEngine.run(history)                            │
    │     ├ stream LLM via OpenAICompatibleClient             │
    │     │   (fetch /chat/completions, SSE 解析)             │
    │     ├ EngineEvent.assistant_delta                       │
    │     │   → yield AgentEvent.message/streamChunk          │
    │     ├ tool_calls? → executeTool(call)                   │
    │     │   ├ registry.get(name).execute(input, ctx)        │
    │     │   │     ┌────────────────────────────────────┐    │
    │     │   │     │ [extension-tools: readPage]        │    │
    │     │   │     │   ctx.rpc.domOp({ kind:'dom/read', │    │
    │     │   │     │                   tabId, mode })   │    │
    │     │   │     │     ┌───────────────────────────┐  │    │
    │     │   │     │     │ [Offscreen: sendDomOp]    │  │    │
    │     │   │     │     │   chrome.runtime.send-    │  │    │
    │     │   │     │     │   Message broadcast       │  │    │
    │     │   │     │     │     ▼                     │  │    │
    │     │   │     │     │ [Content: domHandlers]    │  │    │
    │     │   │     │     │   读 DOM → sendResponse    │  │    │
    │     │   │     │     └───────────────────────────┘  │    │
    │     │   │     └────────────────────────────────────┘    │
    │     │   ├ yield AgentEvent.tool/start                   │
    │     │   ├ ToolResult → push to history                  │
    │     │   └ yield AgentEvent.tool/end                     │
    │     └ done → yield AgentEvent.done(assistantText)       │
    └─────────────────────────────────────────────────────────┘
  }
  
  // 每个 ev 在 offscreen 包 envelope（id/sessionId/ts）+ messageId 后 emit 到 SW port
  // done 时 updateMessage(assistant, content=ev.assistantText) 写 IDB
       │
       ▼ port 'sw-to-offscreen' / 'session'
[Service Worker → Content]
  AgentEvent 流式回传
       │
       ▼
[Content UI]
  RpcClient.subscribe → React 状态更新 → 流式渲染
```

### 关键解耦点

- **agent-core 完全不知道 chrome**：`AgentSession.send` 产生的事件没有 envelope / messageId。这两层是 offscreen 在 wire 上加的（offscreen 是 chrome 胶水）。
- **agent-core 完全不知道 IDB**：消息持久化（`appendMessage` / `updateMessage`）发生在 offscreen 接到 `'done'` 事件后，agent 内部不感知。
- **工具不知道传输**：扩展工具调 `ctx.rpc.domOp(envelope)`；至于 envelope 怎么飞到 content script，由 `rpc.domOp` 实现决定（offscreen 把它绑成 chrome.runtime.sendMessage）。

---

## 5. 数据存储

| 存储 | 用什么 | 存什么 |
|---|---|---|
| IndexedDB | `idb` 包，schema 在 `src/extension/storage/db.ts` | 对话、消息、安装的 skill、审批日志 |
| `chrome.storage.local` | wrappers in `src/extension/storage/{settings,rules}.ts`，Zod 校验 | LLM API key + baseUrl + model、审批规则 |
| `chrome.storage.session` | `src/extension/storage/transient.ts` | 临时 UI 状态；SW 启动时调 `setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` 让 content 也能读 |

agent-core 默认 in-memory；如要持久化，consumer（offscreen）写监听器在 `done` 事件后落库——本仓就是这个模式。

---

## 6. 关键 API 摘要

| 入口 | 来自 | 用途 |
|---|---|---|
| `createAgent(opts)` | `@core` | 装配 agent；返回 `AgentSession` |
| `AgentSession.send(text, opts?)` | `@core` | 发起一轮对话，得到 `AsyncIterable<AgentEvent>` |
| `AgentSession.cancel()` | `@core` | 中断当前调用；下一次 `send()` 自动重置 AbortController |
| `AgentEvent`（zod schema + 推断类型） | `@core/protocol` | 5 种 kind：`message/streamChunk` / `tool/start` / `tool/end` / `done` / `fatalError` |
| `ToolDefinition<I, O, ExtraCtx?>` | `@core/types` | 工具协议；第三泛型注入特化 ctx 字段 |
| `extensionTools` | `@ext-tools` | 5 个 chrome 工具的数组，直接 spread 进 `createAgent` |
| `ExtensionToolCtx` / `ExtensionToolRpc` | `@ext-tools/ctx` | 扩展工具特化 ctx |
| `installDomHandlers()` | `@ext-tools/content/domHandlers` | content script 启动时调一次，注册 DomOp handler |
| `ClientCmd` / wire `AgentEvent` Zod | `@ext/rpc/protocol` | chrome port 上的 wire schema（含 envelope） |

详细签名见 `docs/agent-core-usage.md`。

---

## 7. 加新功能的 cheatsheet

| 你想做什么 | 主要改哪里 |
|---|---|
| 加一个跨环境工具（只用 fetch） | 新文件 `src/agent-core/tools/X.ts`；export 到 `@core/index.ts`；offscreen.ts 把它加进 `tools` 数组 |
| 加一个 chrome 特化工具 | 新文件 `src/extension-tools/tools/X.ts`；如有新 DomOp kind 同步加到 `DomOp.ts` 与 `content/domHandlers.ts`；export 到 `@ext-tools/index.ts` 的 `extensionTools` 数组 |
| 加一个新 chat surface（popup / sidepanel） | 写新的 entry HTML + 内嵌 React 组件；在 SW 里把它挂到 port 协议；agent 装配点仍可复用 offscreen.ts，或新 entry 自己装配（取决于你想不想共享 conversation 状态） |
| 加一个新 LLM provider | 不要直接加。`OpenAICompatibleClient` 是约定边界——把 provider 包成 OpenAI-compatible 网关（很多 provider 已有兼容层），或临时实现一个 fake `OpenAICompatibleClient` 子类传给 `createAgent({ llmClient })`。**不**在 agent-core 里加 multi-provider 抽象（spec 非目标） |
| 加一个新事件类型 | 在 `src/agent-core/protocol.ts` 的 `AgentEvent` discriminatedUnion 末尾加一支；`AgentSession.send` 里在合适地方 yield；`extension/rpc/protocol.ts` 的 wire `AgentEvent` 同步加；offscreen.ts 的 `for await` 加一个 `else if`；UI 端按需消费 |
| 加一个新 wire 命令 | 在 `extension/rpc/protocol.ts` 的 `ClientCmd` discriminatedUnion 加一支；offscreen 的 `handleClientCmd` switch 加 case；content 端 RpcClient 加 sender |

---

## 8. 测试矩阵

| 测试目录 | 跑什么 | 关键 mock |
|---|---|---|
| `tests/agent-core/` | createAgent / AgentSession 单测 | 假 `OpenAICompatibleClient`（自定义 async generator）|
| `tests/agent/` | QueryEngine / OpenAICompatibleClient / tokenBudget | 同上 |
| `tests/tools/` | fetchGet / registry / readPage | jsdom + spy/stub `ctx.rpc` |
| `tests/rpc/` | hub / hub-forward | `tests/mocks/chrome.ts` 提供 chrome.\* mock |
| `tests/storage/` | 各 IDB / chrome.storage 包装 | `fake-indexeddb` + chrome mock |
| `tests/protocol.test.ts` | wire schema validate roundtrips | 无 |

跑：
- 全量：`bun run test`
- 单文件：`bun run test tests/agent-core/createAgent.test.ts`
- 单 case：`bun run test -t "name fragment"`
- typecheck：`bun run typecheck`（用 `tsc -b`）
- build：`bun run build`

---

## 9. 已知未做项（spec 显式非目标）

- 没有 npm 发布；模块仅在本仓内消费
- 没有 CLI / Node / Playwright 入口
- 没有多 LLM provider 抽象
- 没有 OAuth / Bedrock / Vertex
- 没有 sub-agent 调度（接口预留，未实装）
- 没有 stop hooks / compaction（接口预留，未实装）
- 没有 backend interface 抽象层（`BrowserBackend` 没引入——chrome 工具直接用 `ctx.rpc`）

如要做以上任何一项，先开新 spec。
