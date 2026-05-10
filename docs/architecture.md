# mycli-web 架构总览（2026-05-10 抽核之后）

本文档描述 `mycli-web` 仓在 agent-kernel 抽包之后的整体结构。读完后你应该能回答：

- 哪份代码住在哪个包、哪个目录、为什么
- 一条用户消息从输入到 LLM 再回 UI 走过哪几个进程边界
- kernel 与消费方（reference consumer）之间是怎么解耦的
- 想加新功能（工具 / chat surface / 持久化字段）该改哪里

> 历史决策见：
> - `docs/superpowers/specs/2026-04-24-mycli-web-design.md`（原始设计）
> - `docs/superpowers/specs/2026-05-07-agent-core-extraction-design.md`（第一次抽核 / 三层布局）
> - `docs/superpowers/specs/2026-05-10-agent-kernel-extraction-design.md`（当前 workspace 布局）

---

## 1. 两包 workspace 布局

仓现在是一个 **Bun workspace**，根 `package.json` 声明 `"workspaces": ["packages/*"]`。两个包：

```
mycli-web/                                # workspace 根
├── package.json                          # workspaces 声明 + dev deps
├── tsconfig.base.json                    # 共享 compiler options
├── packages/
│   ├── agent-kernel/                     # 库包：可复用的 agent kernel
│   │   ├── package.json                  # name: "agent-kernel"（不发 npm）
│   │   ├── tsconfig.json
│   │   ├── README.md
│   │   ├── docs/
│   │   │   ├── getting-started.md
│   │   │   ├── api-reference.md
│   │   │   └── adapters.md
│   │   ├── src/
│   │   │   ├── index.ts                  # 公开 API 唯一入口
│   │   │   ├── core/                     # agent loop、LLM client、协议（环境无关）
│   │   │   │   ├── createAgent.ts
│   │   │   │   ├── AgentSession.ts
│   │   │   │   ├── QueryEngine.ts
│   │   │   │   ├── OpenAICompatibleClient.ts   # 含 fetchTimeoutMs
│   │   │   │   ├── ToolRegistry.ts
│   │   │   │   ├── Tool.ts                     # makeOk / makeError
│   │   │   │   ├── tokenBudget.ts
│   │   │   │   ├── types.ts                    # ToolDefinition / ToolResult
│   │   │   │   └── protocol.ts                 # AgentEvent zod schema
│   │   │   ├── browser/                  # Chrome MV3 plumbing
│   │   │   │   ├── rpc/
│   │   │   │   │   ├── protocol.ts             # ClientCmd + WireAgentEvent
│   │   │   │   │   ├── hub.ts                  # SW 端 port 路由
│   │   │   │   │   └── client.ts               # 端口 RpcClient
│   │   │   │   ├── agentClient/                # createAgentClient SDK（含心跳）
│   │   │   │   ├── agentService.ts             # deps 注入式编排层
│   │   │   │   ├── domOpClient.ts              # offscreen→content broadcast
│   │   │   │   ├── domOpRouter.ts              # SW chrome.* 代理
│   │   │   │   ├── installKernelBackground.ts  # SW 装配 helper
│   │   │   │   ├── bootKernelOffscreen.ts      # offscreen 装配 helper
│   │   │   │   ├── offscreenChromePolyfill.ts
│   │   │   │   └── storage/
│   │   │   │       ├── db.ts                   # IDB schema（DB name: 'agent-kernel'）
│   │   │   │       ├── conversations.ts
│   │   │   │       └── messages.ts
│   │   │   ├── adapters/                 # 三个消费方接口
│   │   │   │   ├── SettingsAdapter.ts
│   │   │   │   ├── MessageStoreAdapter.ts
│   │   │   │   └── ToolContextBuilder.ts
│   │   │   ├── skills/                   # Skill 协议 + 元工具 + loaders
│   │   │   │   ├── Skill.ts
│   │   │   │   ├── SkillRegistry.ts
│   │   │   │   ├── parseSkillMd.ts
│   │   │   │   ├── useSkillTool.ts
│   │   │   │   ├── readSkillFileTool.ts
│   │   │   │   └── loaders/
│   │   │   │       ├── viteGlobLoader.ts
│   │   │   │       └── fsLoader.ts
│   │   │   ├── tools/
│   │   │   │   └── fetchGet.ts                 # 唯一一个跨环境通用工具
│   │   │   └── errors.ts                       # ErrorCode + classifyError
│   │   └── tests/                              # kernel 单测（约 110 个）
│   │
│   └── mycli-web/                        # reference consumer（Chrome 扩展）
│       ├── package.json                  # 依赖 "agent-kernel": "workspace:*"
│       ├── manifest.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── tsconfig.base.json            # 别名 @, @ext, @ext-tools, @ext-skills
│       ├── html/
│       │   └── offscreen.html
│       ├── scripts/
│       │   └── agent-repl.ts             # Bun CLI demo（用 kernel 的 fsLoader）
│       ├── src/
│       │   ├── extension/                # Chrome MV3 装配
│       │   │   ├── background.ts         # ~20 行：调 installKernelBackground
│       │   │   ├── offscreen.ts          # ~40 行：调 bootKernelOffscreen
│       │   │   ├── settingsAdapter.ts    # 实现 kernel 的 SettingsAdapter
│       │   │   ├── content/              # content script + Shadow DOM
│       │   │   ├── ui/                   # React 组件
│       │   │   ├── options/              # options page entry
│       │   │   └── storage/              # 消费方自家 chrome.storage 包装
│       │   │       ├── settings.ts
│       │   │       ├── rules.ts
│       │   │       └── transient.ts
│       │   ├── extension-tools/          # 浏览器特化业务工具
│       │   │   ├── ctx.ts
│       │   │   ├── DomOp.ts
│       │   │   ├── tools/                # readPage、screenshot、listTabs 等
│       │   │   ├── content/              # domHandlers.ts
│       │   │   └── index.ts
│       │   ├── extension-skills/         # 业务 .md skills
│       │   │   ├── skills/
│       │   │   └── index.ts              # createUseSkillTool({ registry })
│       │   └── styles/
│       └── tests/                        # 消费方自家测试（约 34 + 8 skipped）
│
└── docs/
    ├── architecture.md                   # 本文
    ├── agent-integration.md              # 接入 agent-kernel 的指南
    ├── agent-core-usage.md               # agent-core 单层 API（保留作历史参考）
    └── superpowers/
        ├── specs/
        └── plans/
```

### 包之间的依赖方向（单向）

```
packages/mycli-web  ──→  agent-kernel
                       （workspace:*）
```

- `packages/mycli-web/` import 全部走 bare specifier `agent-kernel`（不通过相对路径）
- `agent-kernel/` 完全不知道 `mycli-web/` 存在
- 两包都能独立 typecheck / test；`bun run build` 仅在 mycli-web 包做

---

## 2. Kernel 内部分层

agent-kernel 自身按职能分四层。所有公开 API 都从 `agent-kernel/src/index.ts` 显式 re-export。

| 层 | 目录 | 关心什么 | 不关心什么 |
|---|---|---|---|
| **core** | `src/core/` | 引擎循环、LLM client、tool/skill 协议、事件 schema | chrome.\*、IDB、UI |
| **browser** | `src/browser/` | Chrome MV3 装配、port RPC、广播 RPC、helper | LLM 流细节、tool 业务 |
| **skills** | `src/skills/` | SkillRegistry、parseSkillMd、useSkill / readSkillFile 元工具、loaders | 任何具体 skill 内容 |
| **adapters** | `src/adapters/` | 消费方实现的接口（settings / messages / toolCtx） | 具体存储后端 |

`tools/fetchGet.ts` 是 kernel 唯一一个跨环境通用工具——只用 `fetch`，没有 chrome 依赖。其他工具由消费方提供。

`errors.ts` 提供 `ErrorCode` 枚举 + `classifyError(e)` helper——LLM HTTP 错误、超时、abort 等都映射到稳定的 code。

详细公开 API 见 [`packages/agent-kernel/docs/api-reference.md`](../packages/agent-kernel/docs/api-reference.md)。

---

## 3. 消费方（mycli-web）的分层

mycli-web 这个包自己也分三层：

| 目录 | 职责 |
|---|---|
| `src/extension/` | Chrome MV3 装配 + UI；调 `installKernelBackground` / `bootKernelOffscreen` |
| `src/extension-tools/` | 浏览器特化业务工具（readPage、screenshot 等） |
| `src/extension-skills/` | 业务 .md skill 内容 + `createUseSkillTool` 调用 |

mycli-web 自己不提供任何 agent loop 实现——全靠 kernel。它实现了三个 adapter：

- **`SettingsAdapter`** → `extension/settingsAdapter.ts`（包 `extension/storage/settings.ts` 的 chrome.storage.local 实现）
- **`MessageStoreAdapter`** → 直接用 kernel 的默认 `createIdbMessageStore`（不覆盖）
- **`ToolContextBuilder`** → 在 `extension/offscreen.ts` 内 inline 构造（接 chrome.tabs.query + sendDomOp / callChromeApi）

---

## 4. 进程边界 / 运行时拓扑

扩展跑在四类 chrome 进程里，靠 message-passing 通信。**不会**共享内存。

| 进程 | 实例数 | 文件 | 职责 |
|---|---|---|---|
| Content Script | 每个用户 tab 一个 | `packages/mycli-web/src/extension/content/` | Shadow-DOM React UI（chat window + FAB），DOM 操作 |
| Service Worker | ≤ 1，事件驱动易休眠 | `packages/mycli-web/src/extension/background.ts` → kernel `installKernelBackground` | RPC 路由、`chrome.*` 代理、offscreen 生命周期、快捷键 |
| Offscreen Document | ≤ 1，按需创建并保活 | `packages/mycli-web/src/extension/offscreen.ts` → kernel `bootKernelOffscreen` | **agent 装配点**：跑 LLM 循环、IDB 读写、emit AgentEvent |
| Sandbox Iframe（未实装） | 每个代码型 skill 一个 | （未来） | 在 null-origin sandbox 跑 skill `tools.js` |

### 两套传输（看清楚是哪条）

两条路径都在 kernel 包里实现；消费方一般不直接碰。

1. **长连接 ports（chat 主路）**：content 端 `RpcClient` `chrome.runtime.connect({ name: 'session' })`，kernel 的 SW hub（`installHub`）接，再开一条 `name: 'sw-to-offscreen'` 转发到 offscreen。Port 上的所有消息走 Zod 校验（schema 在 `packages/agent-kernel/src/browser/rpc/protocol.ts`：`ClientCmd` + `WireAgentEvent`）。
2. **One-shot `chrome.runtime.sendMessage` 广播（工具副路）**：offscreen 的工具通过 `ctx.rpc.domOp(...)` / `ctx.rpc.chromeApi(...)` 广播请求；kernel 的 `domOpRouter`（SW 内）或消费方的 `domHandlers.ts`（content 内）收到后处理并广播 result，offscreen 用 random `id` 关联回应。**不**走 Zod 校验——保持 payload 跟现有 handler 一致。

---

## 5. 一条用户消息的完整旅程

```
[Content UI: ChatApp（mycli-web 自家）]
  user 输入 "读 X 网站标题"
  RpcClient.send({ kind: 'chat/send', text, sessionId })
       │  port 'session'
       ▼
[Service Worker: kernel installHub]
  Zod 校验 ClientCmd
  转发到 offscreen (port 'sw-to-offscreen')
       │
       ▼
[Offscreen: kernel bootKernelOffscreen → agentService.runTurn]
  settings.load()                       // 调消费方的 mycliSettingsAdapter
  messageStore.append(user)             // kernel 默认 IDB
  emit('message/appended' user msg)
  history = messageStore.list(cid)
  toolContext.build(cid)                // 调消费方的 ToolContextBuilder
  
  // ★ kernel 装配 agent ★
  agent = createAgent({
    llm: { apiKey, baseUrl, model, fetchTimeoutMs: 60_000 },
    tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool],
    toolContext,
  })
  
  for await (ev of agent.send(text, { history })) {
    ┌─────────────────────────────────────────────────────────┐
    │  [kernel core: AgentSession.send]                       │
    │     QueryEngine.run(history)                            │
    │     ├ stream LLM via OpenAICompatibleClient             │
    │     │   (fetch /chat/completions + SSE，支持超时)        │
    │     ├ assistant_delta → yield AgentEvent.streamChunk    │
    │     ├ tool_calls? → executeTool(call)                   │
    │     │   ├ registry.get(name).execute(input, ctx)        │
    │     │   │     ┌────────────────────────────────────┐    │
    │     │   │     │ [mycli-web extension-tools:        │    │
    │     │   │     │  readPage]                          │    │
    │     │   │     │   ctx.rpc.domOp({ kind:'dom/read', │    │
    │     │   │     │                   tabId, mode })   │    │
    │     │   │     │     ┌───────────────────────────┐  │    │
    │     │   │     │     │ [kernel domOpClient]      │  │    │
    │     │   │     │     │   chrome.runtime.send-    │  │    │
    │     │   │     │     │   Message broadcast       │  │    │
    │     │   │     │     │     ▼                     │  │    │
    │     │   │     │     │ [content: domHandlers     │  │    │
    │     │   │     │     │  （mycli-web 自家）]      │  │    │
    │     │   │     │     │   读 DOM → sendResponse    │  │    │
    │     │   │     │     └───────────────────────────┘  │    │
    │     │   │     └────────────────────────────────────┘    │
    │     │   ├ yield AgentEvent.tool/start                   │
    │     │   ├ ToolResult → push to history                  │
    │     │   └ yield AgentEvent.tool/end                     │
    │     └ done → yield AgentEvent.done(assistantText)       │
    └─────────────────────────────────────────────────────────┘
  }
  
  // 每个 ev 在 kernel 内包 envelope（id/sessionId/ts）+ messageId 后 emit 到 SW port
  // done 时 messageStore.update(assistant, content=ev.assistantText)
       │
       ▼ port 'sw-to-offscreen' / 'session'
[Service Worker → Content]
  WireAgentEvent 流式回传
       │
       ▼
[Content UI（mycli-web 自家）]
  RpcClient.subscribe → React 状态更新 → 流式渲染
```

### 关键解耦点

- **kernel core 完全不知道 chrome**：`AgentSession.send` 产生的事件没有 envelope / messageId。这两层是 kernel 的 `agentService` 在 wire 上加的（agentService 是 chrome 胶水）。
- **kernel core 完全不知道 IDB**：消息持久化由消费方实现的 `MessageStoreAdapter` 负责（默认是 kernel 提供的 IDB 实现）。agent 内部不感知。
- **工具不知道传输**：扩展工具调 `ctx.rpc.domOp(envelope)`；envelope 怎么飞到 content script，由 kernel 的 `domOpClient` 实现决定。
- **kernel 不知道 mycli-web 的 settings 形状**：通过 `SettingsAdapter` 抽象。消费方爱怎么存怎么存。

---

## 6. 数据存储

| 存储 | 用什么 | 存什么 | 在哪个包 |
|---|---|---|---|
| IndexedDB（kernel 默认） | `idb` 包，DB name `agent-kernel` | 对话、消息、kernel 内部 audit log | `packages/agent-kernel/src/browser/storage/` |
| `chrome.storage.local`（消费方自家） | `packages/mycli-web/src/extension/storage/{settings,rules}.ts`，Zod 校验 | LLM API key + baseUrl + model、审批规则 | `packages/mycli-web/` |
| `chrome.storage.session`（消费方自家） | `packages/mycli-web/src/extension/storage/transient.ts` | 临时 UI 状态；kernel 的 SW boot 调 `setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` 让 content 也能读 | `packages/mycli-web/` |

**命名空间隔离**：kernel 用 DB name `agent-kernel`，消费方如果想自己开 IDB（比如存 skill 安装记录、自家审计日志），用一个不同的 DB name，互不干扰。`chrome.storage.local` 同理：kernel 不强占任何 key；消费方自己挑 key 名。

---

## 7. 关键 API 摘要（消费方视角）

| 入口 | 来自 | 用途 |
|---|---|---|
| `installKernelBackground(opts)` | `agent-kernel` | SW 入口；装上 hub、dom op router、offscreen 生命周期、command/action listener、runtime error 转发 |
| `bootKernelOffscreen(opts)` | `agent-kernel` | offscreen 入口；启动 agentService，处理 chat/send、chat/cancel、chat/resubscribe、ping |
| `createAgentClient(opts?)` | `agent-kernel` | content/options/popup 用的 SDK；含自动心跳 |
| `polyfillChromeApiInOffscreen()` | `agent-kernel` | offscreen entry 顶部必调 |
| `SettingsAdapter` / `MessageStoreAdapter` / `ToolContextBuilder` | `agent-kernel` | 三个消费方接口 |
| `createIdbMessageStore({ defaultConversationTitle? })` | `agent-kernel` | 默认 IDB MessageStore 实现 |
| `fetchGetTool` | `agent-kernel` | 唯一 built-in 通用工具 |
| `loadSkillsFromViteGlob(modules)` / `loadSkillsFromFs(rootDir)` | `agent-kernel` | Skill loader（按环境二选一） |
| `createUseSkillTool({ registry })` / `createReadSkillFileTool({ registry })` | `agent-kernel` | Skill 元工具 factory |
| `ToolDefinition<I, O, ExtraCtx?>` | `agent-kernel` | 工具协议；第三泛型注入特化 ctx 字段 |
| `makeOk(data)` / `makeError(code, message, retryable?)` | `agent-kernel` | ToolResult 助手 |
| `ErrorCode` / `classifyError(e)` | `agent-kernel` | 错误分类 |

详细签名见 [`packages/agent-kernel/docs/api-reference.md`](../packages/agent-kernel/docs/api-reference.md)。
本仓内消费方写法见 [`docs/agent-integration.md`](./agent-integration.md)。

---

## 8. 加新功能的 cheatsheet

| 你想做什么 | 主要改哪里 |
|---|---|
| 加一个浏览器特化工具 | 新文件 `packages/mycli-web/src/extension-tools/tools/X.ts`；如有新 DomOp kind 同步加到 `extension-tools/DomOp.ts` 与 `extension-tools/content/domHandlers.ts`；export 到 `extension-tools/index.ts` 的 `extensionTools` 数组 |
| 加一个跨环境通用工具 | 新文件 `packages/agent-kernel/src/tools/X.ts`；从 `packages/agent-kernel/src/index.ts` re-export |
| 加一个新 skill | 新文件 `packages/mycli-web/src/extension-skills/skills/<name>/SKILL.md`（zero code change，build 时 vite glob 自动收）|
| 加一个新 chat surface（popup / sidepanel） | 写新的 entry HTML + 内嵌 React 组件；用 `createAgentClient()` 接 agent；agent 装配点仍是 offscreen.ts |
| 加一个新 LLM provider | 不要直接加。`OpenAICompatibleClient` 是约定边界——把 provider 包成 OpenAI-compatible 网关。**不**在 kernel 里加 multi-provider 抽象（spec 非目标） |
| 加一个新 wire 命令 | 在 `packages/agent-kernel/src/browser/rpc/protocol.ts` 的 `ClientCmd` discriminatedUnion 加一支；kernel 的 agentService 加 case；消费方端 RpcClient / createAgentClient 加 sender |
| 加一个新 AgentEvent 类型 | 在 `packages/agent-kernel/src/core/protocol.ts` 加；wire schema 同步加；UI 端按需消费 |
| 自己实现 settings 后端 | 写自己的 `SettingsAdapter`；offscreen.ts 把它传给 `bootKernelOffscreen({ settings })` |
| 自己实现 message 持久化 | 写自己的 `MessageStoreAdapter`；offscreen.ts 把它传给 `bootKernelOffscreen({ messageStore })`，不用默认的 `createIdbMessageStore` |

---

## 9. 测试矩阵

| 包 | 测试目录 | 跑什么 |
|---|---|---|
| `packages/agent-kernel/tests/` | `core/` | createAgent / AgentSession / QueryEngine / OpenAICompatibleClient（含超时）/ classifyError |
|  | `skills/` | parseSkillMd / SkillRegistry / use+readSkillFile 元工具 / loaders |
|  | `browser/` | hub / hub-forward / agentClient / agentService / domOpRouter |
|  | `integration/` | live LLM（gated by `MYCLI_TEST_API_KEY`） |
| `packages/mycli-web/tests/` | `tools/` | extension-tools 各工具 |
|  | `extension-skills/` | bundled skills（vite glob 加载） |
|  | `extension/` | settingsAdapter、storage 包装 |
|  | `domOp.routing.test.ts` | 跨上下文 chrome 路由（用 `chromeMultiContext` mock） |

跑：
- 全工作区 typecheck：`bun run typecheck`
- Kernel 测试：`bun --cwd packages/agent-kernel run test`
- Consumer 测试：`bun --cwd packages/mycli-web run test`
- Build：`bun --cwd packages/mycli-web run build`

---

## 10. 已知未做项（spec 显式非目标）

- 没有 npm 发布；`agent-kernel` 仅在本工作区内消费
- 没有 CLI / Node / Playwright 入口（虽然 `scripts/agent-repl.ts` 是个 Bun demo）
- 没有多 LLM provider 抽象
- 没有 OAuth / Bedrock / Vertex / MCP
- 没有 sub-agent 调度（接口预留，未实装）
- 没有 stop hooks / compaction（接口预留，未实装）
- kernel 不打包任何示例 skill；所有 skill 内容由消费方提供

如要做以上任何一项，先开新 spec。
