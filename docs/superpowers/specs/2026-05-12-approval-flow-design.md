# User Approval Flow 设计

状态:spec,待实施
日期:2026-05-12

## 概述

让 mycli-web 的 agent 在执行"危险"工具前(由 `ToolDefinition.requiresApproval` 自报)先停下问用户。已有基础设施:wire 协议两个 schema(`approval/requested` / `approval/reply`)、consumer 端完整的 `ApprovalRule` 存储 + `findMatchingRule` 引擎(`packages/mycli-web/src/extension/storage/rules.ts`)。本 spec 填上之间的空白:**kernel 一等的审批协调器(`ApprovalCoordinator`)、可注入的 `ApprovalAdapter` 接口、QueryEngine 边界 gate、以及 Shadow DOM 审批模态**。

按 kernel-first 原则:审批是 kernel 一等概念,任何 consumer 提供 adapter 即可获得审批能力。本 spec 在 mycli-web 落地一个 reference adapter,接 rules.ts。

## 目标

- `ToolDefinition.requiresApproval: true` 的工具,在 QueryEngine 调 `executeTool` 之前被 gate
- Gate 通过可注入的 `ApprovalAdapter` 决策 `'allow' | 'deny' | 'ask'`
- `'ask'` 触发 wire `approval/requested` → Shadow DOM 模态 → 用户点 4 选 1 → wire `approval/reply` → kernel `ApprovalCoordinator` 解析
- 4 个 decision 映射:
  - `once` → 允许这次,不持久
  - `session` → 允许 + 本会话 sticky(同 tool+args 不再问)
  - `always` → 允许 + 写持久 rule(via `adapter.recordRule`,consumer 落地为 `addRule(...)`)
  - `deny` → 拒绝这次,QueryEngine 返回 tool_result 错误,LLM 看到并继续 reasoning
- mycli-web 落地一个 reference `mycliApprovalAdapter`,接现有的 `findMatchingRule` / `addRule`

## 不在范围(本次)

- 规则管理 UI(Options 页里列已存规则、删除按钮 → 单独的 spec/plan)
- 自动危险性判断(不按 `exec` 位置推断,完全靠 ToolDefinition 自报)
- 多 consumer 实战落地(只在 mycli-web 落一个 adapter,但 kernel 接口为多 consumer 设计)
- 跨会话 sticky:`'session'` 只在当前 `sessionId` 内有效
- 审批超时:pending 一直 wait,直到 reply / turn cancel / 整个 session 销毁
- 同时多 pending:QueryEngine 顺序执行 tool,单 turn 最多 1 个 pending。若未来加并行,需重新审视(本 spec 不解决)
- 审批历史 / audit log:`packages/agent-kernel/src/browser/storage/auditLog.ts` 已存在,本 spec **不**强制接入(可后续 spec)

## 架构

```
┌─ packages/agent-kernel/ ───────────────────────────────────────┐
│  core/approval.ts(新)                                          │
│    types:  ApprovalDecision / ApprovalReplyDecision /           │
│            ApprovalContext / ApprovalRequest / ApprovalAdapter  │
│    class:  ApprovalCoordinator                                  │
│  core/types.ts(改)                                              │
│    ToolDefinition 加 requiresApproval? + summarizeArgs?         │
│  core/QueryEngine.ts(改)                                        │
│    构造参数加 approvalCoordinator? + buildApprovalContext? +    │
│    sessionId;execute 前 gate                                    │
│  core/AgentSession.ts(改)                                       │
│    转 EngineEvent.approval_requested → core 'approval/requested'│
│  core/protocol.ts(改)                                           │
│    AgentEvent 加 core Approval Zod                              │
│  browser/agentService.ts(改)                                    │
│    handle wire 'approval/reply' → coordinator.resolve;         │
│    构造 QueryEngine 时传 approvalCoordinator + adapter          │
│  index.ts(改)                                                   │
│    导出 ApprovalAdapter / ApprovalCoordinator / 等              │
└─────────────────────────────────────────────────────────────────┘
                          ▲ 被引用
                          │
┌─ packages/mycli-web/src/extension/ ────────────────────────────┐
│  mycliApprovalAdapter.ts(新)                                    │
│    接 storage/rules.ts 的 findMatchingRule / addRule            │
│  approvalContextBuilder.ts(新)                                  │
│    从当前 tab(SW chrome.tabs API)拿 origin/url;               │
│    从 args 提 selector(对 querySelector 类工具)               │
│  ui/ApprovalModal.tsx(新)                                       │
│    Shadow DOM 内的模态;监听 'approval/requested';            │
│    4 按钮 → 发 'approval/reply'                                 │
│  ui/ChatWindow.tsx 或入口(改)                                   │
│    挂上 ApprovalModal                                           │
│  agentService 装配处(改)                                        │
│    把 mycliApprovalAdapter + approvalContextBuilder 传给 kernel │
└─────────────────────────────────────────────────────────────────┘
```

## Kernel API 详细设计

### 1. 新文件 `core/approval.ts`

```ts
export type ApprovalDecision = 'allow' | 'deny' | 'ask'
export type ApprovalReplyDecision = 'once' | 'session' | 'always' | 'deny'

/**
 * Consumer-defined context propagated to the adapter and surfaced in the
 * approval/requested event. Kernel doesn't interpret — keys are
 * adapter/consumer convention. Common keys: origin, url, selector.
 */
export interface ApprovalContext {
  [k: string]: unknown
}

export interface ApprovalRequest {
  tool: string
  args: unknown
  ctx: ApprovalContext
}

export interface ApprovalAdapter {
  /** Decide whether the call needs user confirmation. */
  check(req: ApprovalRequest): Promise<ApprovalDecision>
  /**
   * Called when user picks 'always'. Adapter persists the rule.
   * Optional: if adapter doesn't provide this, kernel degrades 'always'
   * to 'session' (with a console.warn).
   */
  recordRule?(req: ApprovalRequest, decision: 'allow' | 'deny'): Promise<void>
}

/**
 * Owns pending approvals + per-session sticky decisions. Single coordinator
 * per kernel install (typically wired by agentService).
 */
export class ApprovalCoordinator {
  constructor(opts: {
    adapter: ApprovalAdapter
    /** Emit hook — agentService translates into the wire approval/requested. */
    emit: (e: { approvalId: string; req: ApprovalRequest; summary: string }) => void
  })

  /** Main entry from QueryEngine. Returns 'allow' or 'deny' (never 'ask'). */
  gate(
    req: ApprovalRequest,
    summary: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<'allow' | 'deny'>

  /** Called by agentService when a wire approval/reply arrives. */
  resolve(approvalId: string, decision: ApprovalReplyDecision): void

  /** Reject all pending for given session (turn-cancel / session-destroy). */
  cancelSession(sessionId: string, reason: string): void
}
```

**`gate` 内部流程**:
1. 先查 `sessionId+tool+argFingerprint` sticky set → 命中 returns `'allow'`
2. `await adapter.check(req)`:
   - `'allow'` / `'deny'` → 直接返回
   - `'ask'`:生成 approvalId,创建 Deferred Promise,调 `emit({approvalId, req, summary})`,await
3. `resolve(approvalId, reply)` 触发 Promise:
   - `once` → resolve `'allow'`,不动 sticky
   - `session` → 加 sticky + resolve `'allow'`
   - `always` → 调 `adapter.recordRule(req, 'allow')`(若 adapter 没 recordRule → console.warn + 降级为 session)+ 加 sticky + resolve `'allow'`
   - `deny` → resolve `'deny'`(不持久,下次会再问 unless adapter has its own deny rule already)

**argFingerprint 实现**:`JSON.stringify(args)` 不做 keys 排序——多问一次比 sticky 漏命中(导致默默执行)安全。

**signal 支持**:gate 接受 turn 的 AbortSignal;abort 时 reject Promise with 标准 abort error;QueryEngine 已有的 try/catch 路径会捕获并产出 `kind: 'done', stopReason: 'cancel'`。

### 2. `core/types.ts` 改

```ts
export interface ToolDefinition<I, O, C> {
  // ...existing
  requiresApproval?: boolean
  /** Optional human-readable summary for the approval dialog.
   *  Default: JSON.stringify(args).slice(0, 200). */
  summarizeArgs?: (args: I) => string
}
```

### 3. `core/QueryEngine.ts` 改

```ts
export interface QueryEngineOptions {
  // ...existing
  approvalCoordinator?: ApprovalCoordinator
  buildApprovalContext?: (call: ToolCall) => ApprovalContext | Promise<ApprovalContext>
  sessionId?: string  // required if approvalCoordinator set
}
```

**EngineEvent 不新增 `approval_requested` variant** — coordinator 通过自己的 `emit` 钩子直接把 approval 事件推给 agentService(见下),不经过 QueryEngine 的 yield 链。QueryEngine 这边只看到一个 `await gate(...)` 调用,完全不知道用户在被问。

执行循环里 `for (const call of toolCallsFinal)` 内,**先** gate:

```ts
const tool = toolsByName.get(call.name)
if (tool?.requiresApproval && this.opts.approvalCoordinator) {
  const ctx = this.opts.buildApprovalContext?.(call) ?? {}
  const req: ApprovalRequest = { tool: call.name, args: call.input, ctx }
  const summary = tool.summarizeArgs
    ? tool.summarizeArgs(call.input as any)
    : JSON.stringify(call.input).slice(0, 200)
  // gate may emit approval_requested via coordinator.emit → up to AgentSession
  const gateResult = await this.opts.approvalCoordinator.gate(
    req, summary, this.opts.sessionId!, this.opts.signal,
  )
  if (gateResult === 'deny') {
    yield {
      kind: 'tool_result', callId: call.id,
      content: 'User denied this tool call.', isError: true,
    }
    // push synthetic tool message into history so LLM sees the rejection
    history.push({ role: 'tool', tool_call_id: call.id, content: 'User denied this tool call.' })
    continue  // skip executeTool
  }
  // 'allow' → fall through to executeTool
}
yield { kind: 'tool_executing', call }
const result = await this.opts.executeTool(call)
// ...
```

**Coordinator 的 emit 旁路设计**:`ApprovalCoordinator` 构造时接受一个 `emit` callback,由 agentService 在装配时绑成"直接 deps.emit 一个 core `approval/requested` 事件"。

这意味着 **approval 事件不经过 EngineEvent → AgentSession → CoreAgentEvent 这条主链**,而是 coordinator → agentService → core/wire AgentEvent。优点:QueryEngine 只 await 一个 Promise,标准 generator 模型即可表达;不用让 generator 中途 yield 等外部。缺点:approval 事件流是"旁路"的,与 streamChunk / tool_start 这些主流事件不在同一序列。文档化即可。

### 4. `core/AgentSession.ts`

不改(approval 不经过这层)。

### 5. `core/protocol.ts`(core AgentEvent Zod)改

加 `ApprovalRequested` schema(虽然 EngineEvent 不走 AgentSession,但 agentService 产出的事件流仍统一类型化为 CoreAgentEvent → WireAgentEvent)。

```ts
const ApprovalRequested = z.object({
  kind: z.literal('approval/requested'),
  approvalId: z.string(),
  tool: z.string(),
  argsSummary: z.string(),
  ctx: z.record(z.string(), z.unknown()),  // 自由形状
})
```

加进 `AgentEvent` discriminated union。

### 6. `browser/agentService.ts` 改

- 装配时:`new ApprovalCoordinator({ adapter: deps.approvalAdapter, emit: e => deps.emit(toWireApprovalRequested(e)) })`,把 coordinator 传给 `new QueryEngine({...})`
- handle `ClientCmd.kind === 'approval/reply'` 路径:`coordinator.resolve(cmd.approvalId, cmd.decision)`,然后 emit `command/ack`
- session cancel 路径:`coordinator.cancelSession(sessionId, 'turn cancelled')`
- `AgentServiceDeps` 增加 `approvalAdapter?: ApprovalAdapter` + `buildApprovalContext?` 字段;缺省 undefined 时:不创建 coordinator,QueryEngine 收到 undefined → 全 fallthrough(老行为)

### 7. `index.ts` 改

```ts
export {
  ApprovalCoordinator,
  type ApprovalAdapter,
  type ApprovalDecision,
  type ApprovalReplyDecision,
  type ApprovalRequest,
  type ApprovalContext,
} from './core/approval'
```

## Consumer 端详细设计

### `mycli-web/src/extension/mycliApprovalAdapter.ts`(新)

```ts
import { findMatchingRule, addRule } from './storage/rules'
import type { ApprovalAdapter } from 'agent-kernel'

export const mycliApprovalAdapter: ApprovalAdapter = {
  async check({ tool, ctx }) {
    const rule = await findMatchingRule({
      tool,
      origin: ctx.origin as string | undefined,
      selector: ctx.selector as string | undefined,
      url: ctx.url as string | undefined,
    })
    if (!rule) return 'ask'
    return rule.decision  // 'allow' | 'deny'
  },
  async recordRule({ tool, ctx }, decision) {
    await addRule({
      tool,
      scope: ctx.origin
        ? { kind: 'origin', origin: ctx.origin as string }
        : { kind: 'global' },
      decision,  // 'allow' | 'deny' matches ApprovalRule.decision
    })
  },
}
```

### `mycli-web/src/extension/approvalContextBuilder.ts`(新)

在 offscreen 跑,从 chrome.tabs(via `callChromeApi`)拿当前活跃 tab 的 url:

```ts
import { callChromeApi } from 'agent-kernel'

export async function buildApprovalContext(call: ToolCall): Promise<ApprovalContext> {
  const tabs = await callChromeApi('tabs.query', { active: true, currentWindow: true })
  const tab = tabs?.[0]
  const url = tab?.url ?? ''
  const origin = url ? new URL(url).origin : undefined
  // selector 仅 querySelector / readSelection 类工具携带,从 args 提
  const selector = (call.input as any)?.selector as string | undefined
  return { origin, url, ...(selector ? { selector } : {}) }
}
```

(callChromeApi 是异步的 → buildApprovalContext 是 async。需要确认 QueryEngine 是否允许 `buildApprovalContext` async。**修订设计**:把它声明为 `Promise<ApprovalContext>` 返回,QueryEngine 改成 `await` 调用。)

### `mycli-web/src/extension/ui/ApprovalModal.tsx`(新)

Shadow DOM 内的模态:
- 监听从 RpcClient 流来的 `approval/requested` 事件
- 单例 pending(后来的 emit 排队;实际单 turn 只 1 个,所以队列长度通常 0-1)
- 4 个按钮 → 发 `approval/reply`
- 工具名 + argsSummary + origin 显示
- ESC 键 = Deny
- 样式与 ChatWindow 一致(同一 Shadow DOM 内嵌)

挂载点:在 ChatWindow 旁边或里面,看现有 UI 组织(implementer 决定)。

### agent 装配处改

`mycli-web` 现在的 agent 装配在 `bootKernelOffscreen({ tools: [...] })` 那里。需要加传 `approvalAdapter: mycliApprovalAdapter` + `buildApprovalContext`。`bootKernelOffscreen` 内部转给 agentService(已存在的 deps 接口扩展)。

### 标 `requiresApproval` 的工具

本 spec 不强制改任何具体工具(避免 scope 蔓延),但 plan 实施时建议把以下标:
- `readPage` — 读整页内容,涉及隐私
- `screenshot` — 截图,可能含敏感
- `readSelection` — 同上但范围小,可考虑不标
- `querySelector` — 标
- `listTabs` — 标(列所有 tab)
- `fetchGet` — 标(发外部请求)

具体哪些标,作为 plan 的 task,由 implementer 与用户在实施前再 align。

## 数据流(简版)

```
LLM → tool_calls → QueryEngine
  ├─ tool.requiresApproval=false → executeTool(call) → result
  └─ tool.requiresApproval=true:
      ├─ buildApprovalContext(call) → ctx
      ├─ coordinator.gate(req, summary, sessionId, signal)
      │   ├─ sticky 命中 → 'allow'
      │   ├─ adapter.check → 'allow' → 'allow'
      │   ├─ adapter.check → 'deny' → 'deny'
      │   └─ adapter.check → 'ask':
      │       ├─ 创建 Deferred + approvalId
      │       ├─ coordinator.emit(...) → agentService.deps.emit(wire approval/requested)
      │       ├─ Shadow DOM ApprovalModal 渲染 + 用户点 'session'
      │       ├─ client cmd approval/reply → agentService → coordinator.resolve(id, 'session')
      │       └─ Deferred resolves 'allow' + 加 sticky
      ├─ 'allow' → executeTool(call)
      └─ 'deny' → yield tool_result error + push synthetic tool message
```

## 错误处理

- `adapter.check` 抛错 → coordinator catch + console.warn,降级为 `'ask'`(保守)
- `adapter.recordRule` 抛错 → console.warn,但 reply 仍按 allow/deny 处理(用户当下被尊重,只是未来还会被问)
- AbortSignal:gate 监听 signal,abort 时 reject Promise → QueryEngine 已有 try/catch 路径
- 收到的 `approval/reply` 的 approvalId 不存在(stale / wrong) → 静默 ignore + console.warn
- `summarizeArgs` 抛错 → fallback 到 `JSON.stringify(args).slice(0, 200)`
- session sticky map 不限大小,会跟随 session 长度自然增长 — 单 session 最多几十次审批,可接受;不加 LRU

## 测试策略(TDD)

### Kernel 单测

- `tests/core/approval/coordinator.test.ts`(新): gate 的 4 个 decision 路径 + sticky 命中 + cancel + recordRule 调用 + adapter 没 recordRule 时 always→session 降级 + check 抛错降级为 ask + abort signal
- `tests/core/queryEngine.approval.test.ts`(新): requiresApproval=true 工具的 gate 接入 + deny 时 tool_result 是错误且 LLM 见到 + allow 时正常 execute + 没 coordinator 时全 fallthrough
- `tests/core/protocol.approval.test.ts`(新或扩 protocol.test.ts): core AgentEvent.ApprovalRequested Zod 解析 + WireAgentEvent.approval/requested 已有(只确认仍 parse)
- `tests/browser/agentService.approval.test.ts`(新或扩 agentService.test.ts): wire approval/reply 路由到 coordinator.resolve + 装配时正确传 adapter

### Consumer 单测

- `tests/extension/mycliApprovalAdapter.test.ts`(新): mock storage,各种 rule shape 触发 'allow'/'deny'/'ask' + recordRule 写入正确 scope
- `tests/extension/approvalContextBuilder.test.ts`(新): mock chrome.tabs,验证 origin/url 提取
- `tests/extension/ui/ApprovalModal.test.tsx`(新,jsdom): 渲染、4 按钮、各按钮发对应 cmd

### 不做 live test

本 spec 验证审批流程,不涉及 LLM 行为本身,跑现有 live test 即可 sanity check 不破坏。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pending 期间 turn cancel 不彻底 | 内存泄漏 + 下次 reply 路由到死 promise | cancelSession 强制 reject,reply 时找不到 approvalId 静默 ignore |
| argFingerprint 用 JSON.stringify 不稳定 | 同样工具+参数不命中 sticky | sticky 漏命中只多问一次,不是 bug;若以后要稳定可换 stable-stringify |
| Adapter check 慢(IO) | gate 阻塞,UI 显示 "thinking" | 没大事,正常 IO 时间(rules 查询是内存里 chrome.storage,毫秒级) |
| 并发 pending(未来 parallel tool) | 当前 1-pending 假设破裂 | 文档说明限制;ApprovalCoordinator 内部已用 Map,本身支持多 pending,只是 sticky+UI 单条假设需要扩 |
| recordRule 失败 | always 没生效 | console.warn;reply 仍按 allow 处理(用户当下被尊重) |

## 前向兼容

- 多 consumer:其他 Chrome 扩展用 kernel 时,只要提供 adapter 即可拥有完整审批流
- 多 pending(parallel tool):coordinator 已用 Map,只需 UI 支持队列
- audit log 接入:auditLog.ts 已存在,coordinator 可后续加 `auditAdapter` 钩子
- 规则管理 UI:rules.ts 已经有 `listRules/removeRule`,后续 spec 加 Options 页即可

## 文件清单

### Kernel(`packages/agent-kernel/`)

| 文件 | 改动 |
|---|---|
| `src/core/approval.ts` | 新建,~150 LOC |
| `src/core/types.ts` | ToolDefinition 加 2 字段 |
| `src/core/QueryEngine.ts` | gate 接入 ~30 LOC |
| `src/core/protocol.ts` | Approval Zod 加进 AgentEvent |
| `src/browser/agentService.ts` | 装配 coordinator + 路由 reply |
| `src/index.ts` | 导出新符号 |
| `tests/core/approval/coordinator.test.ts` | 新建 |
| `tests/core/queryEngine.approval.test.ts` | 新建 |
| `tests/core/protocol.approval.test.ts` | 新建或扩 |
| `tests/browser/agentService.approval.test.ts` | 新建或扩 agentService.test.ts |

### Consumer(`packages/mycli-web/`)

| 文件 | 改动 |
|---|---|
| `src/extension/mycliApprovalAdapter.ts` | 新建 ~30 LOC |
| `src/extension/approvalContextBuilder.ts` | 新建 ~20 LOC |
| `src/extension/ui/ApprovalModal.tsx` | 新建 ~120 LOC |
| `src/extension/ui/ChatWindow.tsx` 或入口 | 挂载 ApprovalModal ~5 LOC |
| `src/extension/offscreen.ts` 或 agent 装配处 | 传 adapter + builder ~5 LOC |
| `tests/extension/mycliApprovalAdapter.test.ts` | 新建 |
| `tests/extension/approvalContextBuilder.test.ts` | 新建 |
| `tests/extension/ui/ApprovalModal.test.tsx` | 新建 |

### 估时

~400 LOC kernel + ~180 LOC consumer + ~250 LOC tests。比 #1 cache observability 大 ~3 倍。

Plan 拟拆 8-9 个 task:
1. `ApprovalCoordinator` + 类型 + 单测
2. `ToolDefinition.requiresApproval/summarizeArgs` + index export
3. QueryEngine 接入 gate + 单测
4. core protocol Zod 加 ApprovalRequested + 单测
5. agentService 装配 + reply 路由 + 单测
6. `mycliApprovalAdapter` + 单测
7. `approvalContextBuilder` + 单测
8. `ApprovalModal` UI + 单测 + 挂载
9. 全栈验证 + handoff
