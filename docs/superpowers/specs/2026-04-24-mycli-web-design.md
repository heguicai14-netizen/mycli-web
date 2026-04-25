---
name: mycli-web — 浏览器 Agent 扩展
date: 2026-04-24
status: approved
source: 与用户的 brainstorm 会话
---

# mycli-web — 浏览器 Agent 扩展

## 1. 我们在造什么

一个 Chrome MV3 扩展，把 mycli 分叉成面向 Web 的 agent。用户在任意页面上通过一个悬浮窗聊天（FAB 或快捷键激活），底层 agent 是 mycli 查询循环的精简移植版本，接 OpenAI-compatible 模型，拥有完整浏览器工具面（DOM、tabs、bookmarks、history、downloads、scripting），并原生支持子 agent（sub-agents）和用户可安装的 skill（包含可携带代码的 skill，代码在 sandbox iframe 中执行）。

项目起点：`cp -R my-cli mycli-web && rm -rf mycli-web/.git`，然后大刀阔斧重组。mycli 绝大部分代码（Ink TUI、CLI bootstrap、MCP、remote bridge、Node-only 工具、native 模块）会被丢弃；只有少数核心文件（query engine、tool protocol、OpenAI-compatible client）被移植，并剥离掉 Node / TUI 依赖。

## 2. 目标与非目标

### 目标（MVP）
- 通过 content script + Shadow DOM 在用户激活 tab 上注入悬浮聊天 UI
- FAB + 快捷键入口；`activeTab` 权限模型
- 仅 OpenAI-compatible 单 provider；配置 `{ apiKey, baseUrl, model }` 存 `chrome.storage.local`
- 完整 Web agent 工具集（读 + 写），写操作走审批
- 子 agent（TaskTool）、对话压缩（compaction）、停止钩子（stop hooks）
- 用户可安装 skill，支持"代码型 skill" 在 sandbox iframe 中执行
- 对话列表，可跨 tab 复用，跨浏览器重启持久化

### 非目标（显式不做）
- Firefox / Safari 支持
- Node-only 工具（读写文件系统、执行 shell）
- MCP / remote bridges / IDE bridge
- OAuth、订阅限流、Bedrock / Vertex / Foundry 适配器
- Ink TUI、CLI bootstrap、slash commands
- Skill 发现市场 / 签名 skill 分发
- 跨会话的长期记忆（推迟）
- 并行子 agent fan-out（接口预留，MVP 串行执行）

### 目标浏览器
仅 Chrome / Chromium 系（覆盖 Chrome、Edge、Brave、Arc），MV3。

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│ 用户当前 tab (用户的页面)                                             │
│ ┌─────────────────────────────────────┐                              │
│ │ Content Script (每 tab 一份)         │                              │
│ │  • Shadow DOM 容器                   │   chrome.runtime port        │
│ │  • React UI (Chat + FAB + Approval) │ ◄──────────────┐             │
│ │  • DOM 操作执行器                    │                │             │
│ └─────────────────────────────────────┘                │             │
└────────────────────────────────────────────────────────┼─────────────┘
                                                         │
┌────────────────────────────────────────────────────────┼─────────────┐
│ 扩展上下文                                              ▼             │
│ ┌─────────────────────────────┐     port     ┌────────────────────┐ │
│ │ Service Worker (易休眠)      │◄────────────►│  Offscreen Document│ │
│ │  • RPC 总线 / 路由            │              │  (Agent Runtime)    │ │
│ │  • chrome.* API 代理          │              │  • QueryEngine      │ │
│ │  • 审批队列                   │              │  • 工具派发          │ │
│ │  • Offscreen 生命周期         │              │  • 子 agent         │ │
│ │  • chrome.commands 快捷键     │              │  • Compaction       │ │
│ └─────────────────────────────┘              │  • IndexedDB I/O    │ │
│                                               │  • 宿主 skill        │ │
│                                               │    sandbox iframes  │ │
│                                               └────┬───────────────┘ │
│                                                    │ postMessage      │
│                                                    ▼                  │
│                                    ┌────────────────────────────────┐ │
│                                    │ Sandbox Iframe (每个代码型 skill)│ │
│                                    │  manifest sandbox: pages       │ │
│                                    │  null origin, 无 chrome.*       │ │
│                                    │  执行 skill 的 tools.js         │ │
│                                    │  RPC: skillHost                │ │
│                                    └────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 组件职责矩阵

| 组件 | 生命周期 | 负责 | 绝不做 |
|---|---|---|---|
| Content Script（N 个） | 页面加载即装，导航即丢 | UI（Shadow DOM）、DOM 操作（click/type/read） | agent 状态、LLM 调用、直接访问 skill sandbox |
| Service Worker（1 个） | 事件驱动、易休眠 | RPC 路由、chrome.* 代理、审批队列、offscreen 生命周期 | agent 循环、长期状态 |
| Offscreen Document（1 个） | 按需创建并保活 | QueryEngine、工具派发、对话内存状态、IndexedDB I/O、sandbox iframe 宿主 | DOM 修改、UI 渲染 |
| Sandbox Iframe（每个代码型 skill 一份） | 父级是 offscreen | 执行 skill 的 `tools.js` | 访问 chrome.*、父 frame DOM、扩展 storage |
| Options Page | 用户打开时 | 设置表单、skill 安装 UI | 跑 agent |

### 跨 tab 操作
Agent 可能需要操作用户发起对话 tab 之外的 tab（比如开新 tab 并在里面点击）。Service Worker 通过 `chrome.scripting.executeScript` 按需把 content script 注入目标 tab。这要求 manifest 声明 `host_permissions: ["<all_urls>"]`（或一个用户可配置的更窄白名单）。安装时用户会明确看到这一权限。

## 4. 仓库结构

```
mycli-web/
├── manifest.json                       # MV3 manifest
├── vite.config.ts                      # Vite + @crxjs/vite-plugin
├── package.json                        # 从 mycli ~130 个依赖裁剪后
├── tsconfig.json
├── html/
│   ├── offscreen.html
│   ├── options.html
│   ├── sandbox.html                    # MV3 manifest.sandbox.pages 入口
│   └── chat.html                       # 可选：独立窗口入口
├── src/
│   ├── agent/                          # 从 mycli 精选移植
│   │   ├── Tool.ts
│   │   ├── query/
│   │   │   ├── QueryEngine.ts
│   │   │   ├── loop.ts
│   │   │   ├── transitions.ts
│   │   │   ├── tokenBudget.ts
│   │   │   ├── compaction.ts
│   │   │   ├── stopHooks.ts
│   │   │   └── config.ts
│   │   ├── api/
│   │   │   ├── openaiCompatibleClient.ts
│   │   │   └── tokenEstimation.ts
│   │   ├── tasks/
│   │   │   ├── Task.ts
│   │   │   ├── LocalAgentTask.ts       # 同 offscreen doc 内的子 agent
│   │   │   ├── taskRegistry.ts
│   │   │   └── TaskTool.ts
│   │   ├── skills/
│   │   │   ├── SkillTool.ts
│   │   │   ├── loader.ts
│   │   │   ├── registry.ts
│   │   │   ├── sandbox/
│   │   │   │   ├── sandboxHost.ts      # offscreen 一侧
│   │   │   │   ├── sandboxRuntime.ts   # iframe 一侧
│   │   │   │   └── sandbox.html
│   │   │   └── bundled/                # 随扩展打包
│   │   │       └── <skill-name>/SKILL.md
│   │   ├── cost.ts
│   │   └── context.ts
│   ├── tools/                          # 浏览器工具实现
│   │   ├── readPage.ts
│   │   ├── readSelection.ts
│   │   ├── querySelector.ts
│   │   ├── screenshot.ts
│   │   ├── fetch.ts
│   │   ├── scroll.ts
│   │   ├── click.ts
│   │   ├── type.ts
│   │   ├── fillForm.ts
│   │   ├── navigate.ts
│   │   ├── tabs.ts                     # list/switch/open/close
│   │   ├── bookmarks.ts
│   │   ├── history.ts
│   │   ├── downloads.ts
│   │   └── injectScript.ts
│   ├── extension/
│   │   ├── background.ts               # service worker 入口
│   │   ├── offscreen.ts                # offscreen doc 入口
│   │   ├── content/
│   │   │   ├── index.ts
│   │   │   ├── fab.tsx
│   │   │   └── inject.ts
│   │   ├── ui/
│   │   │   ├── App.tsx
│   │   │   ├── ChatWindow.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── Composer.tsx
│   │   │   ├── ApprovalPrompt.tsx
│   │   │   ├── ConversationList.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── SubAgentCard.tsx
│   │   │   └── SkillsPicker.tsx
│   │   ├── options/
│   │   │   ├── OptionsApp.tsx
│   │   │   ├── SkillsManager.tsx
│   │   │   └── SkillInstallDialog.tsx
│   │   ├── rpc/
│   │   │   ├── protocol.ts             # zod schemas
│   │   │   ├── hub.ts                  # SW 端路由
│   │   │   └── client.ts               # 各端的 typed client
│   │   ├── permission/
│   │   │   ├── approvals.ts            # 审批队列
│   │   │   └── rules.ts                # 审批规则引擎 + 存储
│   │   └── storage/
│   │       ├── conversations.ts        # IndexedDB：对话 + 消息
│   │       ├── settings.ts             # chrome.storage.local
│   │       ├── skills.ts               # IndexedDB：skill 包
│   │       └── auditLog.ts             # IndexedDB：审计日志
│   └── shared/
│       └── types.ts
```

### 从 mycli 副本中要删除的内容

| 源路径 | 原因 |
|---|---|
| `src/main.tsx`（~800KB）、`src/entrypoints/`、`src/bootstrap-entry.ts`、`src/dev-entry.ts`、`src/bootstrapMacro.ts` | CLI bootstrap，不需要 |
| `src/components/`、`src/ink.ts`、`src/interactiveHelpers.tsx`、`src/replLauncher.tsx`、`src/dialogLaunchers.tsx` | Ink TUI |
| `src/commands/`、`src/commands.ts` | slash commands（MVP 不做） |
| `src/tools/`（原版） | Node 导向的工具；由浏览器工具替换 |
| `src/services/mcp/`、`src/services/remoteManagedSettings/`、`src/remote/`、`src/bridge/` | MCP、remote、IDE bridge |
| `src/tasks/`（原版） | 由更精简的 `src/agent/tasks/` 替代 |
| `src/skills/`（原版） | 由 `src/agent/skills/` 替代 |
| `src/native-ts/`、`shims/`、`vendor/`、`image-processor.node`、`bin/` | native shim、CLI binary |
| `src/services/voice*.ts`、`preventSleep.ts`、`awaySummary.ts`、`voiceKeyterms.ts` | TUI-only service |
| `src/services/mycliAiLimits*`、`rateLimit*`、`mockRateLimits` | 订阅限流 |
| `src/services/api/mycli.ts`、`bedrock*`、`vertex*`、`foundry*` | 非 OpenAI provider |
| `bun.lock`、`bunfig.toml`（bundler 部分） | Bun bundler 配置；bun 仍作包管器可用 |
| `src/setup.ts`、`projectOnboardingState.ts`、`src/history.ts` | 仅 CLI 用的 setup / onboarding |

### 移植时的改造
- `Tool.ts` — 去掉 Ink 渲染（`renderToolUseMessage`、`renderToolResultMessage`）；保留纯 JSON schema + 描述契约。UI 渲染在 `src/extension/ui/ToolCallCard.tsx`
- `QueryEngine.ts` / `query.ts` — 移除 TUI I/O（Ink、stdin、TTY 专属的 AbortController）；暴露为纯异步迭代器：`(input, toolResults) → AsyncIterable<AssistantEvent>`
- `feature()` macro — MVP 内联为常量 `false`；后续若要做 feature flag 再接 `chrome.storage.local` 驱动
- Node built-ins（`fs`、`path`、`child_process`）— 移植完必须清零；用一个 import lint pass 校验
- HTTP 客户端 — `undici` / `axios` 替换为原生 `fetch`（在 service worker、offscreen、sandbox 中都原生可用）

### 构建工具链
- Vite + `@crxjs/vite-plugin` 做 MV3 manifest + HMR + content script 打包
- React 18 + react-dom（不再是 react-reconciler/ink）
- Tailwind CSS（配置成支持 Shadow DOM 注入）
- TypeScript、ESM
- Zod 做进程边界运行时校验（RPC + 存储）
- 包管器：bun（保留 `bun install`）；抛弃 bun bundler

## 5. Agent 能力栈

四层能力共同支撑"强复杂任务处理"：

### 5.1 子 agent（TaskTool）
主 agent 通过 `TaskTool({ description, prompt, subagent_type? })` 派发子 agent。子 agent：
- 在同一 offscreen doc 内跑自己的 `QueryEngine` 循环
- 拥有独立的对话历史和 token 预算
- 共享浏览器工具集和审批规则/队列
- 可以嵌套派发（默认深度上限 3，可配置）
- 结果作为结构化文本返回给父 agent

UI：父对话的消息列表里渲染一张 `SubAgentCard`，显示子 agent 的目标、实时进展和"展开查看完整 trace"控件。

MVP 中子 agent 串行运行（一次一个），但 TaskTool 接口本身接受多个派发；并行执行是 phase 2 选项。

持久化：子 agent 的事件写入 `messages` 存储，沿用父对话的 `conversationId` 并带一个 `subAgentId` 区分（存于 `content` 字段内），这样 UI 可以在 `SubAgentCard` 下折叠/展开，且 trace 在浏览器重启后仍可查。

### 5.2 上下文压缩（Compaction）
触发条件 `usedTokens / modelContextWindow ≥ 0.8`：
- QueryEngine 让 LLM 对较早的消息生成摘要
- 摘要作为 `system-synth` 角色的消息追加
- 原消息在 IndexedDB 中标 `compacted: true`（对用户历史视图仍可见，但 agent 上下文不再带上）
- 下次 LLM 调用重建 context 时跳过 compacted 行

手动触发：聊天头部一个"压缩对话"按钮。

### 5.3 停止钩子（Stop hooks）
从 mycli `src/query/stopHooks.ts` 移植：
- `toolMaxIterations` 上限（默认 50）：达到后停止 agent 循环
- 用户手动取消：UI "停止"按钮发 `chat/cancel` → offscreen 中止在途 LLM 流和下一次工具调用
- 单次工具执行超时（默认 60s；injectScript 和 fetch 有更严格的单次超时）

框架留好（未来可加时间盒任务、cost 上限等钩子）；MVP 只实现上面两条。

### 5.4 Skill
完整 skill 执行模型见 §6。四部分契约：
- **Bundled skill**（随扩展发布）：内联在 `src/agent/skills/bundled/`，不走 sandbox（视为可信）
- **用户 skill**：从 IndexedDB 加载，若携带代码则走 sandbox
- **Prompt-only skill**：只有 `SKILL.md`，带 frontmatter + body；`SkillTool` 把 body 作为 system reminder 注入对话
- **代码型 skill**：增加 `tools.js`（+ 可选 `manifest.json`）；工具在 sandbox iframe 中执行；skill 能向 agent 工具注册表注册新工具名

Skill 也可以标注"引导模式"（guided mode）——被调用时 UI 显示"当前处于 skill X 引导中"，agent 按 skill 的结构化协议行进（brainstorming 类 skill 就是这么运作的）。

## 6. Skill 执行模型（含代码）

### 6.1 Skill 包格式
```
my-skill/
├── SKILL.md        # 必需：frontmatter（name、description、when_to_use）+ body
├── manifest.json   # 可选：声明 skill 请求的能力
└── tools.js        # 可选：导出在 sandbox 里运行的工具定义
```

`manifest.json`：
```json
{
  "name": "github-summarizer",
  "version": "1.0.0",
  "tools": ["summarizeRepo", "listIssues"],
  "hosts": ["https://api.github.com/*"],
  "borrow": ["readPage", "fetch"],
  "llm": true,
  "needsCredentials": []
}
```

### 6.2 Sandbox iframe
- 通过 `manifest.json` 的 `sandbox.pages` 注册：跑在 null origin，无 `chrome.*` 暴露
- Offscreen 每个启用的代码型 skill 创建一个 iframe，会话期保活
- 通过 `iframe.contentWindow.postMessage` 通信，用 Zod 校验的 `SandboxMsg` 协议

### 6.3 `skillHost` API（offscreen 注入，通过 postMessage RPC 调用）

| 方法 | 行为 |
|---|---|
| `host.fetch(url, init)` | 强制走 `manifest.hosts` 白名单（默认严格模式）；默认 `credentials: "omit"`，除非 `manifest.needsCredentials` 允许目标 |
| `host.storage.get(key)` / `set(key, value)` | 每个 skill 命名空间隔离的 IndexedDB 桶 |
| `host.requestTool(name, args)` | 转交给内置工具注册表；走标准审批流程；只允许调用 `manifest.borrow` 中声明的工具名 |
| `host.llm(prompt, opts?)` | 使用当前会话的 LLM 配置；计入用户 API 用量，不隐瞒 |

### 6.4 安装时审批
用户安装 skill（上传文件、粘贴 markdown，或按 URL 拉取——URL 形式多一层"信任该源"确认）。选项页展示：
- Skill 名称、版本、描述
- 将要注册的工具列表（`manifest.tools`）
- 将会访问的网络源（`manifest.hosts`）
- 想要借用的内置工具（`manifest.borrow`）
- 是否使用 LLM / 需要凭据
- 完整 `tools.js` 源码（可折叠）

用户确认 → skill 存入 IndexedDB，进入 skill 注册表，可被调用。

### 6.5 版本升级
Skill 升级时，若 `manifest.tools` / `hosts` / `borrow` / `needsCredentials` 有**扩大**（新增条目），用户必须重新审批（类 Android 权限升级模型）。纯代码更新 + manifest 不变 → 静默升级。

### 6.6 运行时配额
每个 skill，每小时：
- IndexedDB 占用：4MB 软上限
- 工具调用：200 次
- LLM 调用：50 次
- fetch 调用：200 次
超额：skill 工具返回类型化错误；主 agent 决定是否继续。

## 7. 组件 RPC 协议

所有消息在边界处用 Zod 校验。示例 shape：

```ts
const MessageBase = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  ts: z.number(),
})

// Client (content script / options) → offscreen（经 SW 中转）
type ClientCmd =
  | { kind: "chat/send", text: string, attachments?: ... }
  | { kind: "chat/cancel" }
  | { kind: "chat/newConversation", title?: string }
  | { kind: "chat/loadConversation", conversationId: string }
  | { kind: "approval/reply", approvalId: string, decision: "once"|"session"|"always"|"deny" }
  | { kind: "skill/setEnabled", skillId: string, enabled: boolean }
  | { kind: "skill/install", package: SkillPackage }

// Offscreen → client
type AgentEvent =
  | { kind: "message/appended", message: AssistantOrUserMessage }
  | { kind: "message/streamChunk", messageId: string, delta: string }
  | { kind: "tool/start", toolCall: ToolCallSnapshot }
  | { kind: "tool/end", toolCallId: string, result: ToolResult }
  | { kind: "subAgent/spawned", parent: string, child: string, reason: string }
  | { kind: "subAgent/update", child: string, message: AssistantOrUserMessage }
  | { kind: "approval/requested", approval: ApprovalRequest }
  | { kind: "state/snapshot", conversation: ConversationSnapshot }

// Offscreen → 指定 tab 的 content script（经 SW 中转）
type DomOp =
  | { kind: "dom/readPage", tabId: number, mode: "text"|"markdown"|"html-simplified" }
  | { kind: "dom/click", tabId: number, target: Selector }
  | { kind: "dom/type", tabId: number, target: Selector, value: string }
  | { kind: "dom/screenshot", tabId: number }
  | ...

// Offscreen ↔ sandbox iframe（直接 postMessage，不经 SW）
type SandboxMsg =
  | { kind: "skill/callTool", skillId, tool, args }
  | { kind: "skill/result", callId, result }
  | { kind: "skillHost/fetch", callId, url, init }
  | { kind: "skillHost/requestTool", callId, tool, args }
  | { kind: "skillHost/llm", callId, prompt, opts? }
  | { kind: "skillHost/response", callId, result }
```

### 传输
- Content ↔ SW：长连接 `chrome.runtime.connect({ name: "session" })`；onMessage 做事件流
- SW ↔ Offscreen：长连接 Port，SW 在断开时重建 offscreen
- Offscreen ↔ Sandbox：直接 `iframe.contentWindow.postMessage`，Zod 校验，比绕 SW 延迟低
- Options ↔ SW：短 `chrome.runtime.sendMessage` 调用

### 可靠性
- 每条 `ClientCmd` 带 `id`，offscreen 回 `command/ack` 或类型化错误（30s 超时，重放一次）
- Port 断开 → 指数退避重连（1s → 2s → 4s → … 30s 封顶）；重连后发 `chat/resubscribe` 拉 `state/snapshot`
- IndexedDB 写入以 `messageId` 为主键，幂等

## 8. 工具清单

| # | 工具 | 类别 | 执行位置 | 审批 |
|---|---|---|---|---|
| 1 | `readPage` | read | CS | 自动 |
| 2 | `readSelection` | read | CS | 自动 |
| 3 | `querySelector` | read | CS | 自动 |
| 4 | `screenshot` | read | SW | 自动 |
| 5 | `listTabs` | read | SW | 自动 |
| 6 | `searchBookmarks` | read（敏感） | SW | 自动 + 审计日志高亮 |
| 7 | `searchHistory` | read（敏感） | SW | 自动 + 审计日志高亮 |
| 8 | `fetch`（GET） | read | Offscreen | 自动 |
| 9 | `fetch`（非 GET） | write | Offscreen | 确认 |
| 10 | `scroll` | write（温和） | CS | 自动 |
| 11 | `switchTab` | write（温和） | SW | 自动 |
| 12 | `click` | write | CS | 确认 |
| 13 | `type` | write | CS | 确认 |
| 14 | `fillForm` | write | CS | 确认（展示所有字段值） |
| 15 | `navigate` | write | SW | 确认（按目标 origin） |
| 16 | `openTab` | write | SW | 确认（按目标 origin） |
| 17 | `closeTab` | write | SW | 确认 |
| 18 | `createBookmark` | write | SW | 确认 |
| 19 | `download` | write | SW | 确认（无"always"选项） |
| 20 | `injectScript` | write（高危） | SW | 每次确认；无"always"；设置中默认关 |
| 21 | `TaskTool`（子 agent） | meta | Offscreen | 自动（深度受限） |
| 22 | `SkillTool` | meta | Offscreen / sandbox | prompt-only skill 自动；代码型按 skill 自身 manifest |

CS = 目标 tab 的 content script；SW = service worker。

## 9. 审批模型

```ts
type ApprovalRule = {
  id: string
  tool: string
  scope:
    | { kind: "global" }
    | { kind: "origin", origin: string }
    | { kind: "originAndSelector", origin: string, selectorPattern: string }
    | { kind: "urlPattern", pattern: string }
  decision: "allow" | "deny"
  expiresAt?: number         // undefined = 永久
  createdAt: number
}
```

写类工具触发时的查询顺序：`originAndSelector` → `origin` → `urlPattern` → `global`。
- 命中 `deny` → 返回 `ToolError{code:"denied_by_rule"}`
- 命中 `allow` → 执行
- 未命中 → 发 `approval/requested` 给 UI

审批对话框四个选项：`deny` · `allow once` · `allow this session`（2h TTL 或 offscreen 生命周期，先到者结束） · `allow always`。

工具特例：
- `injectScript` 和 `download`：无"always"选项
- `download`：每次都要确认

存储：`chrome.storage.local`（体积小）。选项页可列出/撤销规则。

### 反伪造
- 审批 UI 必须由真实用户事件触发（Shadow DOM listener 校验 `event.isTrusted`）
- 审批组件渲染在 Shadow DOM 中，页面脚本无法通过伪点击绕过
- 审批队列串行化：agent 不能并行发起多个需要审批的工具

## 10. 存储 schema

### 存储分区一览

| 数据 | 存储 | 原因 |
|---|---|---|
| Settings（apiKey、baseUrl、model、开关） | `chrome.storage.local` | 小、跨重启 |
| 审批规则 | `chrome.storage.local` | 小 |
| 对话 + 消息 | IndexedDB | 大、索引查询 |
| Skill 包（manifest + body + 代码） | IndexedDB | blob 大 |
| Skill 自有数据（`host.storage`） | IndexedDB（按 skill 命名空间） | 隔离 + 容量 |
| 审计日志 | IndexedDB | 长、按时间索引 |
| 瞬态 UI 状态（当前对话 id、面板折叠） | `chrome.storage.session` | 重启清除，SW 唤醒保留 |

### IndexedDB schema（db `mycli-web`，v1）

```ts
conversations // 主键：id
{ id, title, createdAt, updatedAt, pinnedTabId?, lastActiveTabUrl?, compactionCount }

messages      // 主键：id；索引 by-conversation：[conversationId, seq]
{ id, conversationId, seq, role: "user"|"assistant"|"tool"|"system-synth",
  content, toolCalls?, toolResults?, createdAt, compacted: boolean, pending?: boolean }

skills        // 主键：id
{ id, name, version, manifest, bodyMarkdown, toolsCode?, hashes,
  source: { kind: "bundled"|"file"|"url", ... }, installedAt, enabled }

skillData     // 复合主键 [skillId, key]
{ skillId, key, value }

auditLog      // 主键：id；索引 by-conversation、by-time
{ id, conversationId?, ts, tool, argsSummary, resultSummary,
  approvalUsed?: ApprovalRule["id"], outcome: "ok"|"denied"|"error" }
```

### Settings 默认值
```ts
{
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  systemPromptAddendum: "",
  subAgentMaxDepth: 3,
  toolMaxIterations: 50,
  fab: { enabled: true, position: "bottom-right" },
  shortcut: "Ctrl+Shift+K",                 // mac 自动映射为 Cmd+Shift+K
  skillHostStrictMode: true,
  injectScriptEnabled: false,
  auditLogRetentionDays: 30,
  bundledSkillsEnabled: [],                 // 安装时由 src/agent/skills/bundled/ 填充；确切名单在 planning 阶段决定
  contextAutoInject: "url-title"            // "none" | "url-title" | "url-title-and-selection"
}
```

### 压缩生命周期
1. 每次 LLM 调用：offscreen 计算 `usedTokens / modelContextWindow`
2. ≥ 0.8 → QueryEngine 对较早的消息发起摘要调用
3. 结果作为 `role: "system-synth"` 消息写入，conversation 的 `compactionCount += 1`
4. 被摘要掉的原消息在 IndexedDB 更新 `compacted: true`
5. 下次构建 context 跳过 compacted 行（最近一条 synth 保留）

### 清理
- 审计日志由 `chrome.alarms` 每日任务按 `auditLogRetentionDays` 裁剪
- 选项页有"导出全部数据"（下载 JSON）和"清空所有对话"按钮
- IndexedDB 配额溢出：降级到只保留最近 20 条对话 + 7 天审计；显示 toast

### 跨导航 UI 复位
瞬态 UI 状态（当前会话、面板开关、滚动位置）每次变更都同步到 `chrome.storage.session`，content script 重新注入时立即复原——避免用户跳新页面后"什么都没了"。

## 11. 错误处理与边界情况

### 统一工具结果契约
```ts
type ToolResult<T = unknown> =
  | { ok: true, data: T }
  | { ok: false, error: { code: string, message: string, retryable: boolean, details?: unknown } }
```
Agent 把 `ok: false` 当成正常工具结果来推理恢复；只有 RPC 层的未捕获异常才作为 `fatalError` 推到 UI。

### 故障模式

| 场景 | 检测 | 处理 |
|---|---|---|
| SW 休眠，port 关闭 | CS 的 `port.onDisconnect` | 指数退避重连；成功后发 `chat/resubscribe` → 拉 `state/snapshot` |
| Offscreen 被回收 | SW 发现 port 断 + 无活跃 client | 下一个 client 请求时重建；offscreen 启动时从 IndexedDB "最近活跃对话"恢复内存状态 |
| Agent 无限循环 | `toolMaxIterations` 计数器 | QueryEngine 停止，插入 `system-synth` 提示，UI 询问继续/重置 |
| 工具执行中 tab 关闭 | `chrome.tabs.onRemoved` 匹配 target | 在途 DOM op 中止 → `ToolError{code:"tab_closed"}`；agent 可开新 tab |
| 导航后 selector 失效 | CS 找不到元素 | `ToolError{code:"selector_not_found"}`；agent 重读页面 |
| `chrome://` / `chrome-extension://` 目标 | SW 预检 `tab.url` | `ToolError{code:"restricted_url"}` |
| LLM 流中断 | fetch 抛错或用户取消 | 部分内容以 `pending: true` 落库；下轮可续；取消不算错 |
| LLM 429 + `Retry-After` | 响应头 | Offscreen 遵守 Retry-After（或指数退避），最多 3 次，仍失败返 `ToolError` |
| IndexedDB `QuotaExceededError` | 写入 try/catch | 软提示用户清理；紧急降级到最近 20 条对话 + 7 天审计 |
| Skill sandbox 崩溃/超时 | `MessageChannel` 超时（30s） | terminate iframe，返 `ToolError`；本次会话标记该 skill "受损" |
| Skill fetch 被 host 白名单拦 | `skillHost.fetch` 命中 denylist | 返结构化 `{code:"host_denied", host, allowed}` 给 skill 代码——不静默失败 |
| 浮窗与页面 CSS 冲突 | Shadow DOM（closed mode）、根节点 `all: initial`、所有样式内联 | 保证页面 CSS 不渗透 |
| Z-index 争斗 | `z-index: 2147483647`，可选 `ResizeObserver` 检测 | 极端时提示"浮窗可能被遮挡"优雅降级 |

### 安全硬规则
- `skillHost.fetch` 默认 `credentials: "omit"`。仅当 `manifest.needsCredentials` 声明目标且用户安装时批准，才允许带 cookie
- 审批 UI 只响应 `event.isTrusted === true` 的事件
- `injectScript` 的 code 在审批对话框中 syntax highlight + 复制按钮展示；审批界面不截断（完整可见）
- Skill 版本升级：若 `tools`/`hosts`/`borrow`/`needsCredentials` 有**扩大**，重新审批

### 审计日志
每次工具调用追加：`{ts, tool, argsSummary, resultSummary, approvalUsed, outcome}`。选项页支持按会话/时间/工具筛选。敏感字段（如 `type` 的值、injectScript 的 code）在列表视图截断，点击可展开。

## 12. 测试策略

### 层 1 — 纯逻辑单元测试（vitest）
- `src/agent/query/` — transitions、tokenBudget、compaction 触发逻辑、stopHooks
- `src/agent/api/openaiCompatibleClient` — 流式解析、错误处理、Retry-After、取消
- 工具 input schema（zod）
- Skill loader — SKILL.md frontmatter 解析、manifest 校验
- 审批规则匹配（特异性排序）

### 层 2 — RPC 契约测试
- Mock `chrome.runtime` / `chrome.storage`（如 `vitest-chrome`）
- 每条 `ClientCmd` / `AgentEvent` / `DomOp` / `SandboxMsg` 变体跑 round-trip
- 断开后重连；快照复位

### 层 3 — 端到端（Playwright 加载扩展）
配置 Playwright persistent context 加载 unpacked `dist/`。核心路径：
1. 首次启动：无配置 → 选项页提示填 apiKey → 回到页面 → FAB 可见 → 快捷键打开浮窗
2. 基础对话：发送提问 → mock LLM 流式响应 → 消息渲染 → 持久化
3. 读路径："这页在讲什么" → agent 触发 `readPage` → 响应合成
4. 写审批：agent 请求 `click` → 审批对话框 → 选 "session" → 点击执行 → 审计条目写入
5. 子 agent：触发复杂任务 → `TaskTool` 触发 → `SubAgentCard` 渲染 → 子循环完成 → 父 agent 续跑
6. Skill 安装：上传测试 skill 包 → 权限清单展示 → 批准 → picker 可见 → 调用 → sandbox 执行
7. Skill sandbox 隔离：恶意 skill 尝试 `chrome.tabs.query` → 失败 → sandbox 抛错被捕获 → agent 拿到清晰错误

### 层 4 — 人工冒烟（`scripts/smoke.md`）
每次发版前在这些站点手动过一遍：
- GitHub、Google、StackOverflow、Twitter/X、Notion、YouTube、某个 SPA、某个严格 CSP 站（银行 landing 等）
- 验证：FAB 存在、浮窗不受页面 CSS 影响、`readPage` 返回有意义文本、`click`/`type`/`navigate` 未被 CSP 阻

### 显式不做的测试
- CLI/TUI 相关
- 跨浏览器兼容
- 视觉回归

### 覆盖目标（软指标）
- 纯逻辑 ≥ 60% line
- 每条 RPC 变体至少 1 条 round-trip 测试
- 7 条 E2E 核心路径通过

## 13. 分阶段交付

### Phase 1（MVP，即本 spec）
§1 ~ §12 的全部内容。目标：可自用、日常浏览中跑得起来，工具面、skill（含代码）、子 agent 都可用。

### Phase 2（MVP 之后，单独 spec）
- Side Panel 作为备选入口（从浮窗"展开到 side panel"）
- 并行子 agent fan-out
- Skill 市场 / URL 安装 + 更好的信任 UI
- 跨会话自动记忆（类 Claude Code）
- 收窄 `host_permissions` 的动态 opt-in 选项

### Phase 3（更长时间跨度）
- 通过 Native Messaging 接入本地 companion，打通 fs / shell
- MCP client 支持（依赖 Native Messaging bridge）
- Firefox / 跨浏览器
- Safari（Xcode 打包）

## 14. 已知风险

- **Shadow DOM 样式隔离** — 某些站点 CSS 激进（全局 `*` 选择器、position 覆盖）。对策是完整的 `all: initial` 重置 + 一组"CSS 敌意"站点的专项冒烟测试
- **MV3 service worker 生命周期** — 引入 offscreen doc 正是因为 SW 本身无法持有 agent 循环。若 Chrome 改变 offscreen API，需跟进迁移风险
- **Skill sandbox 越狱** — `skillHost` 新增的每个 API 都是潜在越狱面。每次扩充 `skillHost` 都要走 manifest 声明 + 审批模型；CI 中放一个"敌意 skill"做 probe
- **Skill 导致数据外泄** — 恶意 skill 声明宽泛 `hosts`，结合 `borrow: [readPage]` 看到的数据可外发。对策是安装时权限清单清晰 + 审计日志可见；运行时无额外防线
- **LLM 费用失控** — 子 agent 会放大 token 用量。对策：UI 显示每对话 cost 指标，设置中可配置支出上限（MVP 不做）

## 15. 留给 planning 决策的开放项

方向已定，实现细节中还有自由度：
- 确切要打包的 bundled skill 集合（从 mycli `src/skills/bundled/` 中挑选并适配浏览器——名单在 planning 决定）
- DOM 操作的 selector 稳定性策略：只 CSS selector，还是额外 fallback 到 XPath / ARIA / 文本匹配？
- Shadow DOM 模式：closed（隔离更好）还是 open（调试更方便）？
- `SkillInstallDialog` 如何预览 `SKILL.md`（Shadow DOM 内渲染 markdown）

以上都不改变架构，只是 planning 阶段的战术选择。
