# Agent Kernel 抽核设计

状态：spec，待 plan + 实施
日期：2026-05-10

## 概述

把当前 mycli-web 内部的 agent + 浏览器 RPC 基础设施抽出成一个**可被任何 Chrome MV3 扩展直接引入**的 kernel 包。kernel 提供 LLM loop、tool 协议、skills 协议、跨 context RPC、SW/offscreen/content 装配 helper、stability 基础（fetch 超时、错误分类）。**消费方**（一个具体扩展）自己写 entry 文件、自己注册 tools、自己装 skills、自己实现 SettingsAdapter。mycli-web 退化成 kernel 的 reference consumer。

## 目标

- 一个 monorepo workspace 装两个包：`packages/agent-kernel/`（库）+ `packages/mycli-web/`（reference 消费扩展）。
- 消费方写 background.ts / offscreen.ts / content 入口各 ~10 行就能把 agent 装起来。
- kernel **不绑定**消费方的 settings schema、storage 命名空间、UI、业务工具。
- 公开 API 收敛：`packages/agent-kernel/index.ts` 只暴露稳定接口；内部 helper 标 `@internal`。
- 自带 Tier 1 稳定性：可配置 LLM fetch 超时、错误分类枚举、cancel 语义保证、SW 心跳保活（已有）。

## 不在范围

- 把 kernel 发到 npm（内部用，workspace 引用即可）。
- Provider 多家适配（OpenAI-compatible only，仍然）。
- 复杂任务能力（sub-agent、approval flow、quotas、code-bearing skills、user-installable skills）—— 设计文档里已留扩展点，本期不做。
- 替换长连 port 为 sendMessage 模式（保留心跳 workaround，文档化技术债）。
- UI 套件（kernel 不出 React 组件；消费方自由实现）。

## 架构

### Workspace 布局

```
mycli-web/                                 # 仓根（保留现名以减少历史包袱）
├── package.json                           # 工作区根
├── packages/
│   ├── agent-kernel/                      # ← 新建库包
│   │   ├── package.json                   # name: "agent-kernel" (内部，不发 npm)
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                   # 公开 API 唯一入口
│   │   │   ├── core/                      # ← 原 src/agent-core/
│   │   │   ├── browser/
│   │   │   │   ├── rpc/                   # ← 原 src/extension/rpc/
│   │   │   │   ├── agentClient.ts         # ← 原 src/extension/agent-client/
│   │   │   │   ├── agentService.ts        # ← 原 src/extension/agentService.ts
│   │   │   │   ├── domOpClient.ts         # ← 原 src/extension/domOpClient.ts
│   │   │   │   ├── domOpRouter.ts         # ← 原 src/extension/domOpRouter.ts
│   │   │   │   ├── offscreenChromePolyfill.ts
│   │   │   │   ├── installKernelBackground.ts  # 新：装配 helper
│   │   │   │   ├── bootKernelOffscreen.ts      # 新：装配 helper
│   │   │   │   └── storage/               # ← 原 src/extension/storage/ 子集
│   │   │   │       ├── db.ts              # 命名空间化（'agent-kernel' DB）
│   │   │   │       ├── conversations.ts
│   │   │   │       ├── messages.ts
│   │   │   │       └── auditLog.ts
│   │   │   ├── adapters/                  # 新：消费方实现的接口
│   │   │   │   ├── SettingsAdapter.ts
│   │   │   │   ├── MessageStoreAdapter.ts
│   │   │   │   └── ToolContextBuilder.ts
│   │   │   ├── skills/                    # ← 原 Skill / SkillRegistry / parseSkillMd / *Tool
│   │   │   │   ├── Skill.ts
│   │   │   │   ├── SkillRegistry.ts
│   │   │   │   ├── parseSkillMd.ts
│   │   │   │   ├── useSkillTool.ts
│   │   │   │   ├── readSkillFileTool.ts
│   │   │   │   └── loaders/               # 可选 helper
│   │   │   │       ├── viteGlobLoader.ts  # 给 vite 消费方
│   │   │   │       └── fsLoader.ts        # 给 Bun/Node 消费方
│   │   │   ├── tools/
│   │   │   │   └── fetchGet.ts            # 唯一一个跨环境的通用工具
│   │   │   ├── errors.ts                  # 新：标准 ErrorCode 枚举
│   │   │   └── _internal/                 # 实现细节，不 re-export
│   │   └── tests/                         # ← 对应单测搬过来
│   │
│   └── mycli-web/                         # ← 当前 src/ 大部分内容降级成消费方
│       ├── package.json                   # 依赖 "agent-kernel": "workspace:*"
│       ├── manifest.json
│       ├── vite.config.ts
│       ├── html/
│       ├── src/
│       │   ├── extension/
│       │   │   ├── background.ts          # ~15 行调 installKernelBackground
│       │   │   ├── offscreen.ts           # ~10 行调 bootKernelOffscreen
│       │   │   ├── content/               # ChatApp 等 UI（消费方自家）
│       │   │   ├── ui/                    # MessageBubble 等
│       │   │   ├── options/
│       │   │   ├── settings.ts            # ← 原 storage/settings.ts，消费方自家
│       │   │   ├── settingsAdapter.ts     # 新：实现 kernel 的 SettingsAdapter
│       │   │   ├── transient.ts           # 消费方自家 chrome.storage 包装
│       │   │   └── rules.ts               # approval rules，消费方自家
│       │   ├── extension-tools/           # 消费方业务工具
│       │   ├── extension-skills/          # 消费方 skill 内容
│       │   └── styles/
│       └── tests/                         # 消费方自家测试
│
├── tsconfig.base.json                     # workspace 共享
└── docs/                                  # 现有文档
```

### Kernel 公开 API（`packages/agent-kernel/src/index.ts`）

按层组织：

```ts
// === core: agent loop & 协议（平台无关）===
export {
  createAgent,
  AgentSession,
  OpenAICompatibleClient,
  ToolRegistry,
  toOpenAiTool,
  makeOk,
  makeError,
} from './core'
export type {
  ToolDefinition, ToolResult, ToolExecContext, ToolCall,
  ChatMessage, AgentEvent as CoreAgentEvent,
  CreateAgentOptions,
} from './core'

// === skills 协议 ===
export {
  SkillRegistry,
  parseSkillMd,
  createUseSkillTool,
  createReadSkillFileTool,
  // 加载 helper（可选，按消费方环境二选一）
  loadSkillsFromViteGlob,
  loadSkillsFromFs,
} from './skills'
export type { SkillDefinition, ParsedSkillMd } from './skills'

// === browser RPC ===
export {
  installHub,
  RpcClient,
  ClientCmd,
  AgentEvent as WireAgentEvent,
} from './browser/rpc'

// === browser agent service & client ===
export { createAgentService, createAgentClient } from './browser'
export type {
  AgentService, AgentServiceDeps,
  AgentClient, MessageOptions, OneShotOptions, OneShotResult,
} from './browser'

// === 装配 helper（assembly kit 的核心）===
export { installKernelBackground } from './browser/installKernelBackground'
export { bootKernelOffscreen } from './browser/bootKernelOffscreen'

// === adapters（接口；消费方实现）===
export type {
  Settings, SettingsAdapter,
  MessageStoreAdapter,
  ToolContextBuilder,
} from './adapters'

// === 默认实现（可选；消费方不实现 adapter 时可用）===
export { createIdbMessageStore } from './browser/storage'

// === 通用工具 ===
export { fetchGetTool } from './tools/fetchGet'

// === 错误分类 ===
export { ErrorCode, classifyError } from './errors'
export type { ClassifiedError } from './errors'

// === polyfill（消费方在 offscreen 入口手动调）===
export { polyfillChromeApiInOffscreen } from './browser/offscreenChromePolyfill'
```

不在公开 API：`_internal/` 下的所有东西、SW hub 内部状态结构、IDB schema 细节。

## Adapter 接口

### `SettingsAdapter`

```ts
export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  systemPromptAddendum?: string
  toolMaxIterations?: number
}

export interface SettingsAdapter {
  load(): Promise<Settings>
  // 可选；不实现的话 kernel 不主动写
  save?(settings: Settings): Promise<void>
}
```

消费方典型实现：

```ts
// mycli-web/src/extension/settingsAdapter.ts
import type { SettingsAdapter, Settings } from 'agent-kernel'
import { loadMyCliSettings } from './settings'

export const mycliWebSettingsAdapter: SettingsAdapter = {
  async load(): Promise<Settings> {
    const s = await loadMyCliSettings()  // 消费方自家 schema
    return {
      apiKey: s.apiKey,
      baseUrl: s.baseUrl,
      model: s.model,
      systemPromptAddendum: s.systemPromptAddendum || undefined,
      toolMaxIterations: s.toolMaxIterations,
    }
  },
}
```

### `MessageStoreAdapter`

```ts
export interface MessageRecord {
  id: string
  role: 'user' | 'assistant' | 'system-synth'
  content: unknown
  createdAt: number
  pending?: boolean
  compacted?: boolean
}

export interface MessageStoreAdapter {
  activeConversationId(): Promise<string>
  append(msg: { conversationId: string; role: 'user' | 'assistant'; content: string; pending?: boolean }): Promise<{ id: string; createdAt: number }>
  list(conversationId: string): Promise<MessageRecord[]>
  update(id: string, patch: { content?: string; pending?: boolean }): Promise<void>
  pushSnapshot?(sessionId: string, conversationId: string | undefined, emit: (ev: any) => void): Promise<void>
}
```

Kernel 提供默认 `createIdbMessageStore({ namespace: string })`，命名空间隔离避免和消费方自家 IDB 冲突。消费方可以完全替换（比如用 chrome.storage、远程 DB、内存 LRU 都行）。

### `ToolContextBuilder`

```ts
export interface ToolContextBuilder<Ctx = Record<string, unknown>> {
  build(conversationId: string | undefined): Promise<Ctx>
}
```

消费方知道自己工具需要什么 ctx 字段（比如 `tabId`、`rpc`），自己 build。Kernel 不假设。

## 装配 helper

### `installKernelBackground` — 消费方 background.ts 入口

```ts
import { installKernelBackground } from 'agent-kernel'

installKernelBackground({
  // 必填
  offscreenUrl: chrome.runtime.getURL('html/offscreen.html'),
  offscreenReason: 'IFRAME_SCRIPTING',
  
  // 可选
  hubMode: 'offscreen-forward',        // 默认 offscreen-forward
  toggleCommand: 'toggle-chat',        // 默认 'toggle-chat'，无则不挂键
  onActivate: async (tabId) => {       // 默认逻辑：发 content/activate
    // 消费方自定义激活流程
  },
})
```

内部职责：
- ensureOffscreen（懒创建）
- 装 hub（`installHub({ mode: hubMode })`）
- 装 dom op router（`installDomOpRouter()`）
- 注册 `chrome.action.onClicked` / `chrome.commands.onCommand` → activateOnTab
- 装 chrome.storage.session 访问级别widening
- 装运行时错误捕获 → hub.broadcastRuntimeError

消费方 background.ts 极简示例：

```ts
// mycli-web/src/extension/background.ts
import { installKernelBackground } from 'agent-kernel'
installKernelBackground({
  offscreenUrl: chrome.runtime.getURL('html/offscreen.html'),
  offscreenReason: 'IFRAME_SCRIPTING',
})
```

### `bootKernelOffscreen` — 消费方 offscreen.ts 入口

```ts
import {
  bootKernelOffscreen,
  polyfillChromeApiInOffscreen,
  fetchGetTool,
  createUseSkillTool,
  createReadSkillFileTool,
  createIdbMessageStore,
} from 'agent-kernel'

polyfillChromeApiInOffscreen()  // 消费方先 polyfill

bootKernelOffscreen({
  // 必填
  settings: mySettingsAdapter,
  tools: [fetchGetTool, ...myExtensionTools, useSkillTool, readSkillFileTool],
  
  // 消费方自己 build 的 ctx，每 turn 调一次
  buildToolContext: myToolContextBuilder,
  
  // 可选 — 不传走 kernel 默认 IDB
  messageStore: createIdbMessageStore({ namespace: 'mycli-web' }),
})
```

内部职责：
- 装 SW connect listener（`chrome.runtime.onConnect` for `sw-to-offscreen`）
- 装运行时错误捕获 → swPort.postMessage
- 提供 emit() → swPort
- 处理所有 ClientCmd kind（`chat/send`、`chat/cancel`、`chat/newConversation`、`chat/resubscribe`）
- chat/send → 调 createAgentService(deps).runTurn

消费方仍需要自己提供 `useSkillTool`、`readSkillFileTool` 实例（绑定到自己的 SkillRegistry）。Kernel 的 `createUseSkillTool` factory 是 helper。

### `createAgentClient` — content/options/popup 入口（已有）

不变，从 `agent-kernel` 导出。

## 默认实现 vs 消费方实现

| 概念 | Kernel 提供 | 消费方一定要做 |
|---|---|---|
| Settings schema | 接口 + 必填字段 | 实现 SettingsAdapter |
| Settings 持久化 | ❌ | 自己存（chrome.storage / env / cloud） |
| Conversations / Messages 持久化 | 默认 IDB 实现，命名空间化 | 可选覆盖 |
| Tool 协议 | ToolDefinition 类型 + 默认 fetchGet | 提供自己的 tools 数组 |
| Skill 协议 + 元工具 + 加载器 | SkillDefinition、SkillRegistry、parseSkillMd、useSkillTool / readSkillFileTool factory、viteGlob loader、fs loader | **全部 .md 内容由消费方自己写**——kernel 不打包任何 skill |
| Tool ctx 构造 | ❌（不假设字段） | 实现 ToolContextBuilder |
| 聊天 UI | ❌（不出 React 组件） | 自己实现（或参考 mycli-web） |
| RPC 路由 | ✓ 全包 | ❌ |
| SW/offscreen 装配 | ✓ helper 提供 | 调 helper |
| 错误转发 to F12 | ✓ 自动 | ❌ |
| chrome.* polyfill | ✓ | 调 polyfill 函数 |

**Skills 的 kernel/消费方分工**（强调一下，因为容易误读）：

```
kernel 给的是骨架和工具：
  • SkillDefinition / SkillRegistry / parseSkillMd（协议）
  • createUseSkillTool / createReadSkillFileTool（元工具 factory）
  • loadSkillsFromViteGlob / loadSkillsFromFs（loader，按消费方环境二选一）

消费方提供全部内容：
  • 在自己包内写 src/extension-skills/skills/<name>/SKILL.md（多少个都行）
  • 在自己 offscreen entry 里:
      const skillRegistry = loadSkillsFromViteGlob(import.meta.glob('./skills/**/*.md', {...}))
      const useSkill = createUseSkillTool({ registry: skillRegistry })
      const readSkillFile = createReadSkillFileTool({ registry: skillRegistry })
      bootKernelOffscreen({ tools: [...myTools, useSkill, readSkillFile], ... })
  • 想用 fs 加载（CLI / Bun 场景）就换 loadSkillsFromFs

kernel 不发任何示例 skill；mycli-web reference consumer 里那个 summarizePage 留在
mycli-web 包内作为示范。
```

## 命名空间隔离

kernel 默认 IDB DB name：`agent-kernel`，object stores 加前缀避免和消费方自家 IDB 撞：
- `agent-kernel/conversations`
- `agent-kernel/messages`
- `agent-kernel/auditLog`

消费方自家 IDB 用自家 DB name（如 `mycli-web`），互不干扰。

`chrome.storage.local` 同理：kernel 不强占任何 key；消费方实现 SettingsAdapter 时自己挑 key 名。

## Tier 1 稳定性增强（与抽核同期做）

### LLM fetch 超时

`OpenAICompatibleClient` 加可配置 hard timeout（默认 60s），到点 abort 内部 controller，转成 `ClassifiedError(code: 'timeout')` 抛给 QueryEngine。

```ts
new OpenAICompatibleClient({
  apiKey, baseUrl, model,
  fetchTimeoutMs: 60_000,  // 新；默认 60s
})
```

### 错误分类枚举

```ts
// agent-kernel/src/errors.ts
export enum ErrorCode {
  Network = 'network',           // 网络层（DNS、TCP、CORS）
  Auth = 'auth',                 // 401 / 403
  RateLimit = 'rate_limit',      // 429
  BadRequest = 'bad_request',    // 4xx 其他
  Server = 'server',             // 5xx
  Timeout = 'timeout',           // 客户端超时
  Abort = 'abort',               // 主动取消
  ToolError = 'tool_error',      // 工具返回 ok:false
  Schema = 'schema',             // 协议 schema 校验失败
  Unknown = 'unknown',
}

export interface ClassifiedError {
  code: ErrorCode
  message: string
  retryable: boolean
  cause?: unknown
}

export function classifyError(e: unknown): ClassifiedError
```

`OpenAICompatibleClient` 错误抛 `ClassifiedError`；`QueryEngine` `done` 事件携带它；`AgentEvent.fatalError` 走标准 code。

### Cancel 语义保证

文档化：`agent.cancel()` 调用后 ≤2s 内 stream 必须 yield 终止 done event（`stopReason: 'cancel'`）。Kernel 内部所有等待都接 AbortSignal。新增测试：所有现有 live 用例派生一个 "cancel mid-stream" 变体。

### SW 心跳（保留 + 文档化）

ChatApp 现有 25s 心跳保留。Kernel 提供 helper 让任何消费方 RpcClient 都能自动心跳（不用每个 client 自己写）：

```ts
// agent-kernel
export interface CreateAgentClientOptions {
  // ...existing
  heartbeatMs?: number  // 默认 25_000；设 0 关闭
}
```

`createAgentClient` 内部 setInterval 自动 ping。

## Public/Internal 边界

- 所有公开 API 在 `agent-kernel/src/index.ts` 显式 re-export
- 内部模块标 `@internal` JSDoc 注释 + 放进 `_internal/` 子目录
- 公开 API 改动需要 CHANGELOG 一条；内部改动不需要
- TypeScript 不强制（没法在编译期阻止深 import），靠 lint rule + code review

## Workspace 工具链

- Bun workspaces：根 `package.json` 加 `"workspaces": ["packages/*"]`
- TS project references 跨包工作：`packages/mycli-web/tsconfig.json` references `../agent-kernel/tsconfig.json`
- Vite 在消费方包配置；kernel 不依赖 vite（loader 是可选 export）
- Vitest 配置 per-package；根可有 aggregate
- 路径别名：消费方包内 `@`/`@ext` 等保留；kernel 不用别名（避免引入复杂度）

## 测试策略

| 层 | 现状 | 抽核后 |
|---|---|---|
| agent-core | 9+7+7+6+5+5 单测 | 全搬到 packages/agent-kernel/tests/core |
| skills | 7+7+6+5+6+5 单测 | 全搬 |
| RPC routing | 7（domOp.routing） | 全搬 |
| agentService 编排 | 9 | 全搬 |
| AgentClient SDK | 4 | 全搬 |
| Bundled skills | 5 | **不搬**——是消费方测试，留在 mycli-web |
| 浏览器工具（readPage 等） | 3+ | **不搬**——消费方测试 |
| Live LLM | 8 gated | 留 kernel 包，docs 说明怎么 opt-in |

新增测试：
- `installKernelBackground` 用 chrome mock 验证 helper 装上正确的 listener 们
- `bootKernelOffscreen` 验证 lifecycle、emit、port 处理
- `classifyError` 单测覆盖每个 ErrorCode
- `OpenAICompatibleClient` fetch timeout 单测（mock 永不返回的 fetch）
- `createAgentClient` heartbeat 单测（fake timer，断言 setInterval(25s)）

## 迁移路径（mycli-web → reference consumer）

实施时的安全顺序：

1. **创建 workspace** — 根加 `workspaces: ["packages/*"]`，新建 `packages/agent-kernel` 和 `packages/mycli-web` 空目录
2. **复制（不移动）现有 src/ 到 packages/mycli-web/src/** —— 保证旧路径还在，能临时跑
3. **抽 kernel 文件到 packages/agent-kernel/src/** —— 同时保留 mycli-web 版本，但内部引 kernel 版本
4. **改 import**：mycli-web 的 import 指向 `agent-kernel`
5. **删除 mycli-web 里被抽走的重复文件**
6. **跑全套测试** 确认行为不变
7. **重写 mycli-web entry 文件用 helper** —— 真正验证 assembly kit
8. **删除根 src/** —— 抽核完成
9. **写文档 + 更新 CLAUDE.md / architecture.md**

## 文档产物

抽核完成时：

- `packages/agent-kernel/README.md` — 包总览
- `packages/agent-kernel/docs/getting-started.md` — 5 分钟接入指南
- `packages/agent-kernel/docs/api-reference.md` — 公开 API 详解
- `packages/agent-kernel/docs/adapters.md` — 三个 adapter 接口的实现指南
- `packages/agent-kernel/docs/error-handling.md` — ErrorCode + classifyError + 各 event kind
- `packages/agent-kernel/CHANGELOG.md` — 起步版本 0.1.0
- mycli-web 的 README 更新成"reference consumer extension for agent-kernel"
- 仓根 `CLAUDE.md` 更新讲两包关系
- `docs/architecture.md` 重写为新 workspace 架构
- `docs/agent-integration.md` 重写为"基于 agent-kernel 写消费扩展"

## 待观察问题

1. **bun workspaces vs pnpm**：仓现在用 bun，bun workspaces 比较新，可能有边角问题。如果踩坑就改 pnpm（root package.json 加 `"packageManager": "pnpm@..."`）。
2. **TS project references 跨包是否丝滑**：理论上工作，但 workspace 内 reference 路径需要测一下 watch mode、build cache 行为。
3. **vite plugin @crxjs 在 workspace 子包工作正常吗**：消费方包用 vite + crxjs；kernel 包不用 vite。crxjs 应该 OK，但 workspace 跨包的 manifest 路径要验证。
4. **skill loaders 的环境检测**：消费方在 vite 上下文用 viteGlobLoader、在 Bun 上下文用 fsLoader——如果都不在（如 Webpack 5）就只能消费方自己写。文档强调即可。
5. **`createAgentClient` heartbeat 默认值**：25s 在大多数 MV3 环境够，但极端低性能或代理环境可能不够。是否暴露成必填配置？决策：默认 25s，可被覆盖，0 表示关。
6. **kernel 是否需要 SubAgent 类型预留**：当前不实施，但要不要把 protocol 里 `subAgent/spawned`、`subAgent/update` event kind 保留？决策：保留（已经在 protocol.ts 里），不会有运行时影响。

## 最终文件清点（kernel 包）

抽核完成后 `packages/agent-kernel/src/` 树（约 35 个文件）：

```
packages/agent-kernel/src/
├── index.ts                                  # 公开 API
├── core/
│   ├── createAgent.ts
│   ├── AgentSession.ts
│   ├── QueryEngine.ts
│   ├── OpenAICompatibleClient.ts             # 加 fetchTimeoutMs
│   ├── ToolRegistry.ts
│   ├── Tool.ts
│   ├── tokenBudget.ts
│   ├── types.ts
│   ├── protocol.ts
│   └── index.ts                              # 内 barrel
├── browser/
│   ├── rpc/
│   │   ├── client.ts                         # RpcClient
│   │   ├── hub.ts
│   │   ├── protocol.ts
│   │   └── index.ts
│   ├── agentClient.ts                        # createAgentClient（带心跳）
│   ├── agentService.ts
│   ├── domOpClient.ts
│   ├── domOpRouter.ts
│   ├── offscreenChromePolyfill.ts
│   ├── installKernelBackground.ts            # 新
│   ├── bootKernelOffscreen.ts                # 新
│   ├── storage/
│   │   ├── db.ts                             # namespace='agent-kernel'
│   │   ├── conversations.ts
│   │   ├── messages.ts
│   │   ├── auditLog.ts
│   │   ├── createIdbMessageStore.ts          # 新：默认 MessageStoreAdapter 实现
│   │   └── index.ts
│   └── index.ts
├── adapters/
│   ├── SettingsAdapter.ts
│   ├── MessageStoreAdapter.ts
│   ├── ToolContextBuilder.ts
│   └── index.ts
├── skills/
│   ├── Skill.ts                              # SkillDefinition + parseSkillMd
│   ├── SkillRegistry.ts
│   ├── useSkillTool.ts
│   ├── readSkillFileTool.ts
│   ├── loaders/
│   │   ├── viteGlobLoader.ts                 # ← 原 extension-skills/loader
│   │   └── fsLoader.ts                       # ← 原 scripts/agent-repl 内的 fs loader 抽出
│   └── index.ts
├── tools/
│   └── fetchGet.ts
├── errors.ts                                 # 新：ErrorCode + classifyError
└── _internal/                                # 实现细节，不 re-export
```

## 实施时长估算

| 阶段 | 内容 | 天 |
|---|---|---|
| 1 | Workspace + 文件迁移 + import 修复 | 3-4 |
| 2 | Adapter 接口 + 装配 helper（installKernelBackground / bootKernelOffscreen）+ mycli-web 重写 entry | 3-4 |
| 3 | Tier 1 稳定性（fetch 超时 + ErrorCode + classifyError + 心跳进 SDK） | 2-3 |
| 4 | 文档（getting-started / api-reference / adapters / 重写 architecture / agent-integration） | 2-3 |
| | **小计** | **10-14 天** |

## 接受标准

- [ ] mycli-web 的 background.ts ≤ 20 行，offscreen.ts ≤ 20 行
- [ ] mycli-web 不再 import 任何 `src/agent-core` 路径，只 import `agent-kernel`
- [ ] kernel 包能在消费方完全不写自家 storage 的情况下跑（用默认 IDB）
- [ ] 全套现有测试 + 新增测试 100% 过
- [ ] 现有 agent-repl.ts 仍能跑（用 fsLoader）
- [ ] live skill flow 测试仍过
- [ ] 文档：5 分钟从零开始装到一个新 demo 扩展能跑（手册写出来）
