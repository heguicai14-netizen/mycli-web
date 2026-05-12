# User Approval Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 kernel 加 `ApprovalCoordinator` + `ApprovalAdapter` 接口让 `requiresApproval=true` 的工具调用前 gate;在 mycli-web 落一个 reference adapter 接 rules.ts 并加 Shadow DOM 审批模态。Kernel 可被任何浏览器扩展复用。

**Architecture:** 三层边界——`kernel/core/` 零 chrome 依赖(Coordinator/types/QueryEngine gate);`kernel/browser/` 可用 chrome.\*(activeTabContext utility + agentService 装配);`mycli-web/` 包一切 mycli-web 特定的 adapter + UI + tool 名字假设。Approval 事件走 coordinator 旁路(不经 EngineEvent 链),QueryEngine 只 `await gate()` 拿 'allow' / 'deny'。

**Tech Stack:** TypeScript / Bun / Vitest / Zod / React (在 Shadow DOM 里) / Chrome MV3。

**Spec:** `docs/superpowers/specs/2026-05-12-approval-flow-design.md`

**重要约束:**
- 守 `packages/mycli-web/CLAUDE.md`(OpenAI-compatible only,不加 provider)
- **kernel core/ 零 `chrome.*` 调用**(都在 browser/ 下)
- `mycli-web/` 是唯一允许 hardcode rules.ts schema / 具体 tool 名字 / 具体 UI 的地方
- TDD;每个 task 一个 commit;`cd <pkg> && bun run <script>`(`bun --cwd` 不工作)
- 每改完一个 task: typecheck + 受影响 package 的 test 全绿 + consumer build OK

---

## File Map

**kernel — core/(零 chrome 依赖)**:

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/agent-kernel/src/core/approval.ts` | **新建** types + `ApprovalCoordinator` | ~150 |
| `packages/agent-kernel/src/core/types.ts` | `ToolDefinition` 加 `requiresApproval?` + `summarizeArgs?` | ~5 |
| `packages/agent-kernel/src/core/QueryEngine.ts` | 构造参数加 `approvalCoordinator?` / `buildApprovalContext?` / `sessionId?`;execute 前 gate | ~40 |
| `packages/agent-kernel/src/core/protocol.ts` | `AgentEvent` discriminated union 加 `ApprovalRequested` Zod | ~10 |

**kernel — browser/(可 chrome.*)**:

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/agent-kernel/src/browser/activeTabContext.ts` | **新建** `buildActiveTabApprovalContext` utility | ~20 |
| `packages/agent-kernel/src/browser/agentService.ts` | `AgentServiceDeps` 加 `approvalAdapter?` / `buildApprovalContext?`;handle wire `approval/reply` → coordinator.resolve;装配 Coordinator | ~50 |
| `packages/agent-kernel/src/index.ts` | 导出新 symbols | ~10 |

**consumer — mycli-web**:

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/mycli-web/src/extension/mycliApprovalAdapter.ts` | **新建** adapter 接 rules.ts | ~30 |
| `packages/mycli-web/src/extension/approvalContextBuilder.ts` | **新建** compose kernel utility + selector 提取 | ~15 |
| `packages/mycli-web/src/extension/ui/ApprovalModal.tsx` | **新建** Shadow DOM 模态 | ~120 |
| `packages/mycli-web/src/extension/offscreen.ts` 或 `bootKernelOffscreen` 调用处 | 传 adapter + builder | ~5 |
| `packages/mycli-web/src/extension/content/` 入口 | 挂 `<ApprovalModal />` | ~3 |

**Tests**:

| 文件 | 改动 |
|---|---|
| `packages/agent-kernel/tests/core/approval/coordinator.test.ts` | **新建** |
| `packages/agent-kernel/tests/core/queryEngine.approval.test.ts` | **新建** |
| `packages/agent-kernel/tests/core/protocol.test.ts` | 扩(加 core AgentEvent ApprovalRequested cases) |
| `packages/agent-kernel/tests/browser/activeTabContext.test.ts` | **新建** |
| `packages/agent-kernel/tests/browser/agentService.test.ts` | 扩(加 approval/reply routing cases) |
| `packages/mycli-web/tests/extension/mycliApprovalAdapter.test.ts` | **新建** |
| `packages/mycli-web/tests/extension/approvalContextBuilder.test.ts` | **新建** |
| `packages/mycli-web/tests/extension/ui/ApprovalModal.test.tsx` | **新建** |

---

## Task 1: Kernel — `ApprovalCoordinator` + 类型 + `ToolDefinition` 扩展 + 导出

**Files:**
- Create: `packages/agent-kernel/src/core/approval.ts`
- Modify: `packages/agent-kernel/src/core/types.ts`(+5 行)
- Modify: `packages/agent-kernel/src/index.ts`(加新导出)
- Create: `packages/agent-kernel/tests/core/approval/coordinator.test.ts`

- [ ] **Step 1: Write failing tests for `ApprovalCoordinator`**

```ts
// packages/agent-kernel/tests/core/approval/coordinator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ApprovalCoordinator, type ApprovalAdapter } from 'agent-kernel'

const stubAdapter = (overrides: Partial<ApprovalAdapter> = {}): ApprovalAdapter => ({
  check: vi.fn().mockResolvedValue('ask'),
  recordRule: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

const makeCoord = (opts: { adapter?: ApprovalAdapter; emit?: any } = {}) => {
  const adapter = opts.adapter ?? stubAdapter()
  const emit = opts.emit ?? vi.fn()
  const coord = new ApprovalCoordinator({ adapter, emit })
  return { coord, adapter, emit }
}

describe('ApprovalCoordinator.gate', () => {
  it('returns allow when adapter says allow', async () => {
    const { coord } = makeCoord({ adapter: stubAdapter({ check: vi.fn().mockResolvedValue('allow') }) })
    const res = await coord.gate({ tool: 't', args: {}, ctx: {} }, 'sum', 's1')
    expect(res).toBe('allow')
  })

  it('returns deny when adapter says deny', async () => {
    const { coord } = makeCoord({ adapter: stubAdapter({ check: vi.fn().mockResolvedValue('deny') }) })
    const res = await coord.gate({ tool: 't', args: {}, ctx: {} }, 'sum', 's1')
    expect(res).toBe('deny')
  })

  it('emits approval_requested when adapter says ask, then resolves on reply=once → allow', async () => {
    const { coord, emit } = makeCoord()
    const p = coord.gate({ tool: 't', args: { a: 1 }, ctx: {} }, 'do thing', 's1')
    // wait one tick for adapter.check to complete and emit to fire
    await new Promise((r) => setTimeout(r, 0))
    expect(emit).toHaveBeenCalledTimes(1)
    const arg = (emit as any).mock.calls[0][0]
    expect(arg.approvalId).toBeTypeOf('string')
    expect(arg.summary).toBe('do thing')
    expect(arg.req.tool).toBe('t')
    coord.resolve(arg.approvalId, 'once')
    expect(await p).toBe('allow')
  })

  it('reply=deny resolves to deny', async () => {
    const { coord, emit } = makeCoord()
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 's1')
    await new Promise((r) => setTimeout(r, 0))
    const id = (emit as any).mock.calls[0][0].approvalId
    coord.resolve(id, 'deny')
    expect(await p).toBe('deny')
  })

  it('reply=session adds sticky so subsequent gate returns allow without re-asking', async () => {
    const { coord, adapter, emit } = makeCoord()
    const p1 = coord.gate({ tool: 't', args: { x: 1 }, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'session')
    expect(await p1).toBe('allow')
    // adapter.check was called once
    expect((adapter.check as any)).toHaveBeenCalledTimes(1)
    // second call same tool+args+session → sticky hit, no adapter call, no emit
    const p2 = coord.gate({ tool: 't', args: { x: 1 }, ctx: {} }, 's', 'sess')
    expect(await p2).toBe('allow')
    expect((adapter.check as any)).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('sticky scoped per sessionId — different session re-asks', async () => {
    const { coord, adapter, emit } = makeCoord()
    const p1 = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'A')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'session')
    await p1
    const p2 = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'B')
    await new Promise((r) => setTimeout(r, 0))
    expect((adapter.check as any)).toHaveBeenCalledTimes(2)
    coord.resolve((emit as any).mock.calls[1][0].approvalId, 'once')
    await p2
  })

  it('reply=always calls adapter.recordRule and stickys for session', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const { coord, emit } = makeCoord({
      adapter: stubAdapter({ check: vi.fn().mockResolvedValue('ask'), recordRule: record }),
    })
    const p = coord.gate({ tool: 't', args: { a: 1 }, ctx: { origin: 'x' } }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'always')
    expect(await p).toBe('allow')
    expect(record).toHaveBeenCalledWith(
      { tool: 't', args: { a: 1 }, ctx: { origin: 'x' } },
      'allow',
    )
  })

  it('reply=always with no recordRule warns and degrades to session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { coord, emit } = makeCoord({
      adapter: { check: vi.fn().mockResolvedValue('ask') }, // no recordRule
    })
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'always')
    expect(await p).toBe('allow')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('adapter.check throwing degrades to ask (safe default)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { coord, emit } = makeCoord({
      adapter: stubAdapter({ check: vi.fn().mockRejectedValue(new Error('boom')) }),
    })
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    expect(emit).toHaveBeenCalledTimes(1)
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'once')
    expect(await p).toBe('allow')
    warn.mockRestore()
  })

  it('cancelSession rejects pending promises for that session', async () => {
    const { coord, emit } = makeCoord()
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    expect(emit).toHaveBeenCalledTimes(1)
    coord.cancelSession('sess', 'abort')
    await expect(p).rejects.toThrow(/abort/)
  })

  it('resolve with unknown approvalId is silently ignored (warn only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { coord } = makeCoord()
    coord.resolve('does-not-exist', 'once')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('AbortSignal aborts pending gate', async () => {
    const { coord } = makeCoord()
    const ac = new AbortController()
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess', ac.signal)
    await new Promise((r) => setTimeout(r, 0))
    ac.abort(new Error('user cancel'))
    await expect(p).rejects.toThrow(/cancel/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/agent-kernel && bun run test tests/core/approval/coordinator.test.ts
```
Expected: FAIL with import error `ApprovalCoordinator` / `ApprovalAdapter` not exported from `agent-kernel`.

- [ ] **Step 3: Create `core/approval.ts`**

```ts
// packages/agent-kernel/src/core/approval.ts
export type ApprovalDecision = 'allow' | 'deny' | 'ask'
export type ApprovalReplyDecision = 'once' | 'session' | 'always' | 'deny'

/**
 * Consumer-defined context propagated to the adapter and surfaced in the
 * approval/requested event. Kernel does not interpret — keys are
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
  /** Decide whether the tool call needs user confirmation. */
  check(req: ApprovalRequest): Promise<ApprovalDecision>
  /**
   * Called when user picks 'always'. Adapter persists the rule.
   * Optional: if adapter doesn't provide this, kernel degrades 'always' to
   * 'session' (logged via console.warn).
   */
  recordRule?(req: ApprovalRequest, decision: 'allow' | 'deny'): Promise<void>
}

type Deferred = {
  resolve: (v: 'allow' | 'deny') => void
  reject: (e: unknown) => void
  sessionId: string
}

/**
 * Owns pending approvals + per-session sticky decisions. Typically one
 * coordinator per kernel install, wired by agentService (or any other
 * consumer that builds its own assembly).
 *
 * Pure TS — zero chrome / DOM dependency. Reusable across any host.
 */
export class ApprovalCoordinator {
  private pending = new Map<string, Deferred>()
  /** Key: `${sessionId} ${tool} ${argFingerprint}` → 'allow' */
  private sticky = new Map<string, 'allow'>()

  constructor(
    private opts: {
      adapter: ApprovalAdapter
      /** Emit hook — consumer translates into wire approval/requested. */
      emit: (e: { approvalId: string; req: ApprovalRequest; summary: string }) => void
    },
  ) {}

  async gate(
    req: ApprovalRequest,
    summary: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<'allow' | 'deny'> {
    // 1. sticky hit?
    const stickyKey = this.stickyKey(sessionId, req.tool, req.args)
    if (this.sticky.has(stickyKey)) return 'allow'

    // 2. adapter check
    let decision: ApprovalDecision
    try {
      decision = await this.opts.adapter.check(req)
    } catch (e) {
      console.warn('[ApprovalCoordinator] adapter.check threw, degrading to ask', e)
      decision = 'ask'
    }
    if (decision === 'allow' || decision === 'deny') return decision

    // 3. ask — create deferred, emit, wait
    const approvalId = crypto.randomUUID()
    const promise = new Promise<'allow' | 'deny'>((resolve, reject) => {
      this.pending.set(approvalId, { resolve, reject, sessionId })
    })
    if (signal) {
      if (signal.aborted) {
        this.pending.delete(approvalId)
        throw signal.reason ?? new Error('aborted')
      }
      signal.addEventListener(
        'abort',
        () => {
          const d = this.pending.get(approvalId)
          if (d) {
            this.pending.delete(approvalId)
            d.reject(signal.reason ?? new Error('aborted'))
          }
        },
        { once: true },
      )
    }
    this.opts.emit({ approvalId, req, summary })
    return promise
  }

  resolve(approvalId: string, reply: ApprovalReplyDecision): void {
    const d = this.pending.get(approvalId)
    if (!d) {
      console.warn('[ApprovalCoordinator] resolve called with unknown approvalId', approvalId)
      return
    }
    this.pending.delete(approvalId)
    // Reconstruct req from pending — we need it for sticky key + recordRule.
    // Store req on the Deferred instead:
    // (refactor inline — Deferred extended below)
    const req = (d as Deferred & { req?: ApprovalRequest }).req
    if (reply === 'deny') {
      d.resolve('deny')
      return
    }
    if (reply === 'once') {
      d.resolve('allow')
      return
    }
    if (reply === 'session') {
      if (req) this.sticky.set(this.stickyKey(d.sessionId, req.tool, req.args), 'allow')
      d.resolve('allow')
      return
    }
    // reply === 'always'
    if (req && this.opts.adapter.recordRule) {
      this.opts.adapter.recordRule(req, 'allow').catch((e) => {
        console.warn('[ApprovalCoordinator] adapter.recordRule failed', e)
      })
      this.sticky.set(this.stickyKey(d.sessionId, req.tool, req.args), 'allow')
    } else {
      console.warn(
        '[ApprovalCoordinator] reply=always but adapter has no recordRule — degrading to session',
      )
      if (req) this.sticky.set(this.stickyKey(d.sessionId, req.tool, req.args), 'allow')
    }
    d.resolve('allow')
  }

  cancelSession(sessionId: string, reason: string): void {
    for (const [id, d] of this.pending) {
      if (d.sessionId === sessionId) {
        this.pending.delete(id)
        d.reject(new Error(reason))
      }
    }
  }

  private stickyKey(sessionId: string, tool: string, args: unknown): string {
    return `${sessionId} ${tool} ${this.fingerprint(args)}`
  }

  private fingerprint(args: unknown): string {
    try {
      return JSON.stringify(args)
    } catch {
      return String(args)
    }
  }
}
```

Wait — the resolve method needs access to req for sticky/recordRule. Refactor `Deferred` to carry req:

```ts
type Deferred = {
  resolve: (v: 'allow' | 'deny') => void
  reject: (e: unknown) => void
  sessionId: string
  req: ApprovalRequest
}
```

In `gate`:
```ts
this.pending.set(approvalId, { resolve, reject, sessionId, req })
```

In `resolve`, just `d.req` (no need for the cast hack). **Replace** the file content's deferred declaration and the `resolve` method accordingly.

**Final file content** (use this directly):

```ts
// packages/agent-kernel/src/core/approval.ts
export type ApprovalDecision = 'allow' | 'deny' | 'ask'
export type ApprovalReplyDecision = 'once' | 'session' | 'always' | 'deny'

export interface ApprovalContext {
  [k: string]: unknown
}

export interface ApprovalRequest {
  tool: string
  args: unknown
  ctx: ApprovalContext
}

export interface ApprovalAdapter {
  check(req: ApprovalRequest): Promise<ApprovalDecision>
  recordRule?(req: ApprovalRequest, decision: 'allow' | 'deny'): Promise<void>
}

type Deferred = {
  resolve: (v: 'allow' | 'deny') => void
  reject: (e: unknown) => void
  sessionId: string
  req: ApprovalRequest
}

export class ApprovalCoordinator {
  private pending = new Map<string, Deferred>()
  private sticky = new Map<string, 'allow'>()

  constructor(
    private opts: {
      adapter: ApprovalAdapter
      emit: (e: { approvalId: string; req: ApprovalRequest; summary: string }) => void
    },
  ) {}

  async gate(
    req: ApprovalRequest,
    summary: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<'allow' | 'deny'> {
    const stickyKey = this.stickyKey(sessionId, req.tool, req.args)
    if (this.sticky.has(stickyKey)) return 'allow'

    let decision: ApprovalDecision
    try {
      decision = await this.opts.adapter.check(req)
    } catch (e) {
      console.warn('[ApprovalCoordinator] adapter.check threw, degrading to ask', e)
      decision = 'ask'
    }
    if (decision === 'allow' || decision === 'deny') return decision

    const approvalId = crypto.randomUUID()
    const promise = new Promise<'allow' | 'deny'>((resolve, reject) => {
      this.pending.set(approvalId, { resolve, reject, sessionId, req })
    })
    if (signal) {
      if (signal.aborted) {
        this.pending.delete(approvalId)
        throw signal.reason ?? new Error('aborted')
      }
      signal.addEventListener(
        'abort',
        () => {
          const d = this.pending.get(approvalId)
          if (d) {
            this.pending.delete(approvalId)
            d.reject(signal.reason ?? new Error('aborted'))
          }
        },
        { once: true },
      )
    }
    this.opts.emit({ approvalId, req, summary })
    return promise
  }

  resolve(approvalId: string, reply: ApprovalReplyDecision): void {
    const d = this.pending.get(approvalId)
    if (!d) {
      console.warn('[ApprovalCoordinator] resolve called with unknown approvalId', approvalId)
      return
    }
    this.pending.delete(approvalId)
    if (reply === 'deny') {
      d.resolve('deny')
      return
    }
    if (reply === 'once') {
      d.resolve('allow')
      return
    }
    if (reply === 'session') {
      this.sticky.set(this.stickyKey(d.sessionId, d.req.tool, d.req.args), 'allow')
      d.resolve('allow')
      return
    }
    if (this.opts.adapter.recordRule) {
      this.opts.adapter.recordRule(d.req, 'allow').catch((e) => {
        console.warn('[ApprovalCoordinator] adapter.recordRule failed', e)
      })
      this.sticky.set(this.stickyKey(d.sessionId, d.req.tool, d.req.args), 'allow')
    } else {
      console.warn(
        '[ApprovalCoordinator] reply=always but adapter has no recordRule — degrading to session',
      )
      this.sticky.set(this.stickyKey(d.sessionId, d.req.tool, d.req.args), 'allow')
    }
    d.resolve('allow')
  }

  cancelSession(sessionId: string, reason: string): void {
    for (const [id, d] of this.pending) {
      if (d.sessionId === sessionId) {
        this.pending.delete(id)
        d.reject(new Error(reason))
      }
    }
  }

  private stickyKey(sessionId: string, tool: string, args: unknown): string {
    return `${sessionId} ${tool} ${this.fingerprint(args)}`
  }

  private fingerprint(args: unknown): string {
    try {
      return JSON.stringify(args)
    } catch {
      return String(args)
    }
  }
}
```

- [ ] **Step 4: Extend `ToolDefinition` in `core/types.ts`**

Locate(approx line 55):

```ts
export interface ToolDefinition<I = unknown, O = unknown, ExtraCtx = Record<string, never>> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: I, ctx: ToolExecContext & ExtraCtx): Promise<ToolResult<O>>
}
```

Change to:

```ts
export interface ToolDefinition<I = unknown, O = unknown, ExtraCtx = Record<string, never>> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: I, ctx: ToolExecContext & ExtraCtx): Promise<ToolResult<O>>
  /** When true, the kernel will gate this tool's calls through ApprovalCoordinator. */
  requiresApproval?: boolean
  /** Optional human-readable summary of args for the approval dialog.
   *  Default: JSON.stringify(args).slice(0, 200). */
  summarizeArgs?: (input: I) => string
}
```

- [ ] **Step 5: Export new symbols from `index.ts`**

Find the existing block (after `OpenAICompatibleClient` exports). Add a new block:

```ts
// === core: approval flow ===
export {
  ApprovalCoordinator,
  type ApprovalAdapter,
  type ApprovalContext,
  type ApprovalDecision,
  type ApprovalReplyDecision,
  type ApprovalRequest,
} from './core/approval'
```

- [ ] **Step 6: Run tests to verify pass**

```bash
cd packages/agent-kernel && bun run test tests/core/approval/coordinator.test.ts
```
Expected: PASS — 11 cases green.

- [ ] **Step 7: Full kernel typecheck + tests**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
```
Expected: typecheck clean. 249 + 11 = 260 tests green (kernel baseline was 249 after T1 of cache observability).

- [ ] **Step 8: Commit**

```bash
git add packages/agent-kernel/src/core/approval.ts \
        packages/agent-kernel/src/core/types.ts \
        packages/agent-kernel/src/index.ts \
        packages/agent-kernel/tests/core/approval/coordinator.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): ApprovalCoordinator + ApprovalAdapter + ToolDefinition fields

Adds the kernel-level approval primitives. Pure TS — zero chrome / DOM
dependency, reusable across any browser extension (or any host that
provides an adapter). Coordinator handles pending state, sticky session
decisions, and 'always' rule persistence via adapter.recordRule. Tool
authors opt in by setting requiresApproval=true on their ToolDefinition.

Coordinator is not yet wired into QueryEngine — that's the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Kernel — core `protocol.ts` adds `ApprovalRequested` Zod

**Files:**
- Modify: `packages/agent-kernel/src/core/protocol.ts`(加 schema + 入 discriminated union)
- Modify: `packages/agent-kernel/tests/core/protocol.test.ts`(扩)

- [ ] **Step 1: Write failing tests**

Append to `packages/agent-kernel/tests/core/protocol.test.ts`. The file currently tests `WireAgentEvent`; for the core one we import it under a separate alias.

```ts
// At top of file, add to imports:
//   import { AgentEvent as CoreAgentEvent } from 'agent-kernel'
// (if WireAgentEvent is already aliased as AgentEvent, keep both)

import { AgentEvent as CoreAgentEvent } from 'agent-kernel'

describe('Core AgentEvent — approval/requested', () => {
  it('accepts approval/requested with all fields', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'approval/requested',
      approvalId: '33333333-3333-4333-8333-333333333333',
      tool: 'readPage',
      argsSummary: 'Read https://example.com',
      ctx: { origin: 'https://example.com', url: 'https://example.com/foo' },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts approval/requested with empty ctx', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'approval/requested',
      approvalId: '33333333-3333-4333-8333-333333333333',
      tool: 't',
      argsSummary: '',
      ctx: {},
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects approval/requested missing approvalId', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'approval/requested',
      tool: 't',
      argsSummary: '',
      ctx: {},
    })
    expect(parsed.success).toBe(false)
  })
})
```

(The first existing top-level import line in this file is `import { ClientCmd, WireAgentEvent as AgentEvent, Envelope } from 'agent-kernel'`. Adjust it to also include `AgentEvent as CoreAgentEvent`:

```ts
import {
  ClientCmd,
  WireAgentEvent as AgentEvent,
  AgentEvent as CoreAgentEvent,
  Envelope,
} from 'agent-kernel'
```

Note `AgentEvent` (core, from `core/protocol.ts`) is already exported from kernel index, just under that name — and `WireAgentEvent` is the renamed export. Both names exist in `index.ts`.)

- [ ] **Step 2: Run tests to confirm fail**

```bash
cd packages/agent-kernel && bun run test tests/core/protocol.test.ts
```
Expected: 3 new cases FAIL — schema doesn't recognize `approval/requested`.

- [ ] **Step 3: Add `ApprovalRequested` Zod to `core/protocol.ts`**

In `packages/agent-kernel/src/core/protocol.ts`, after the existing schemas (e.g., after `Usage` block, before `AgentEvent` discriminated union), add:

```ts
// Approval flow event — emitted by ApprovalCoordinator when adapter.check
// returns 'ask'. Consumer's UI must capture this and send back a wire-level
// approval/reply.
const ApprovalRequested = z.object({
  kind: z.literal('approval/requested'),
  approvalId: z.string(),
  tool: z.string(),
  argsSummary: z.string(),
  ctx: z.record(z.string(), z.unknown()),
})
```

In the `AgentEvent` discriminated union, add `ApprovalRequested`:

```ts
export const AgentEvent = z.discriminatedUnion('kind', [
  StreamChunk,
  ToolStart,
  ToolEnd,
  Done,
  FatalError,
  Usage,
  AssistantIter,
  ApprovalRequested,   // <-- new
  CompactStarted,
  CompactCompleted,
  CompactFailed,
])
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd packages/agent-kernel && bun run test tests/core/protocol.test.ts
```
Expected: all cases green.

- [ ] **Step 5: Full kernel test**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
```
Expected: typecheck clean, 260 + 3 = 263 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-kernel/src/core/protocol.ts \
        packages/agent-kernel/tests/core/protocol.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): core AgentEvent gains approval/requested

Additive Zod schema in core/protocol.ts AgentEvent. ctx is record<string,
unknown> — kernel does not interpret context keys. Used by
agentService (next task) to forward coordinator emits as core events
before they get re-wrapped as wire events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Kernel — `QueryEngine` integrates gate

**Files:**
- Modify: `packages/agent-kernel/src/core/QueryEngine.ts`(加构造参数 + 在 tool execute 前 gate)
- Create: `packages/agent-kernel/tests/core/queryEngine.approval.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-kernel/tests/core/queryEngine.approval.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  QueryEngine,
  ApprovalCoordinator,
  type OpenAICompatibleClient,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
} from 'agent-kernel'

function fakeClient(batches: StreamEvent[][]): OpenAICompatibleClient {
  let i = 0
  return {
    async *streamChat() {
      const b = batches[i++] ?? []
      for (const ev of b) yield ev
    },
  } as Pick<OpenAICompatibleClient, 'streamChat'> as OpenAICompatibleClient
}

const fakeTool = (
  overrides: Partial<ToolDefinition<any, any, any>> = {},
): ToolDefinition<any, any, any> => ({
  name: 'dangerous',
  description: 'x',
  inputSchema: {},
  execute: vi.fn().mockResolvedValue({ ok: true, data: 'tool-result' }),
  requiresApproval: true,
  ...overrides,
})

const fakeOpenAiToolSchema = {
  type: 'function' as const,
  function: { name: 'dangerous', description: 'x', parameters: {} },
}

describe('QueryEngine approval gate', () => {
  it('gates tool with requiresApproval=true through coordinator', async () => {
    const tool = fakeTool()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('allow') },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: { x: 1 } }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    expect((tool.execute as any)).toHaveBeenCalledTimes(1)
  })

  it('skips tool when coordinator returns deny and pushes synthetic tool_result', async () => {
    const tool = fakeTool()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('deny') },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: {} }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    expect((tool.execute as any)).not.toHaveBeenCalled()
    const toolResult = out.find((e) => e.kind === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content).toMatch(/denied/i)
  })

  it('does not gate when tool.requiresApproval is undefined', async () => {
    const tool = fakeTool({ requiresApproval: undefined })
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('deny') },  // would deny if asked
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: {} }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    expect((tool.execute as any)).toHaveBeenCalledTimes(1)
  })

  it('uses buildApprovalContext to populate req.ctx', async () => {
    const tool = fakeTool()
    const checkSpy = vi.fn().mockResolvedValue('allow')
    const coord = new ApprovalCoordinator({
      adapter: { check: checkSpy },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: { selector: '#x' } }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
      buildApprovalContext: (call) => ({
        origin: 'https://example.com',
        selector: (call.input as any)?.selector,
      }),
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    const arg = (checkSpy as any).mock.calls[0][0]
    expect(arg.ctx).toEqual({ origin: 'https://example.com', selector: '#x' })
  })

  it('uses tool.summarizeArgs when provided', async () => {
    const summarize = vi.fn().mockReturnValue('custom summary')
    const tool = fakeTool({ summarizeArgs: summarize })
    const emit = vi.fn()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('ask') },
      emit,
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: { a: 1 } }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    // Kick off but don't wait — we need to inspect the emit synchronously
    const runP = (async () => {
      const out: any[] = []
      for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
      return out
    })()
    await new Promise((r) => setTimeout(r, 0))
    expect(summarize).toHaveBeenCalledWith({ a: 1 })
    const emitArg = emit.mock.calls[0][0]
    expect(emitArg.summary).toBe('custom summary')
    // resolve the pending approval so engine can finish
    coord.resolve(emitArg.approvalId, 'once')
    await runP
  })
})
```

- [ ] **Step 2: Run tests to confirm fail**

```bash
cd packages/agent-kernel && bun run test tests/core/queryEngine.approval.test.ts
```
Expected: FAIL — `QueryEngine` doesn't accept `approvalCoordinator` / `toolDefinitions` / `buildApprovalContext` / `sessionId`.

- [ ] **Step 3: Update `QueryEngine.ts`**

`packages/agent-kernel/src/core/QueryEngine.ts`:

Add to imports at top:

```ts
import type {
  OpenAICompatibleClient,
  ChatMessage,
  NormalizedUsage,
} from './OpenAICompatibleClient'
import type { ToolCall, ToolResult, ToolDefinition } from './types'
import type { ApprovalContext, ApprovalCoordinator } from './approval'
import { truncateForLLM } from './truncate'
```

Update `QueryEngineOptions`:

```ts
export interface QueryEngineOptions {
  client: OpenAICompatibleClient
  tools: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  executeTool: (call: ToolCall) => Promise<ToolResult>
  toolMaxIterations?: number
  systemPrompt?: string
  signal?: AbortSignal
  toolMaxOutputChars?: number
  /** Definitions for the tools listed above. Needed to look up
   *  `requiresApproval` / `summarizeArgs` per call. Optional — when missing,
   *  approval is never triggered (back-compat). */
  toolDefinitions?: Array<ToolDefinition<any, any, any>>
  /** Approval coordinator. When set, requires sessionId. */
  approvalCoordinator?: ApprovalCoordinator
  /** Required when approvalCoordinator is set. Identifies the session for
   *  sticky decisions. */
  sessionId?: string
  /** Build ApprovalContext from the tool call. Sync or async. Default: {}. */
  buildApprovalContext?: (
    call: ToolCall,
  ) => ApprovalContext | Promise<ApprovalContext>
}
```

Inside the `for (const call of toolCallsFinal)` loop in `run()`, **before** the existing `yield { kind: 'tool_executing', call }`, insert the gate:

```ts
      for (const call of toolCallsFinal) {
        const def = this.opts.toolDefinitions?.find((t) => t.name === call.name)
        if (def?.requiresApproval && this.opts.approvalCoordinator) {
          if (!this.opts.sessionId) {
            throw new Error('QueryEngine: approvalCoordinator set without sessionId')
          }
          const ctx = (await this.opts.buildApprovalContext?.(call)) ?? {}
          const summary = def.summarizeArgs
            ? def.summarizeArgs(call.input)
            : JSON.stringify(call.input).slice(0, 200)
          const gateResult = await this.opts.approvalCoordinator.gate(
            { tool: call.name, args: call.input, ctx },
            summary,
            this.opts.sessionId,
            this.opts.signal,
          )
          if (gateResult === 'deny') {
            const denyContent = `User denied this tool call: ${call.name}.`
            yield { kind: 'tool_result', callId: call.id, content: denyContent, isError: true }
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              content: denyContent,
            })
            continue
          }
        }
        yield { kind: 'tool_executing', call }
        const result = await this.opts.executeTool(call)
        // ... existing post-execution logic stays unchanged
```

(The exact patch: the existing for-loop body — between the `for (const call of toolCallsFinal) {` and the line currently containing `yield { kind: 'tool_executing', call }` — gets the gate block prepended. Everything else in the loop body stays.)

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd packages/agent-kernel && bun run test tests/core/queryEngine.approval.test.ts
```
Expected: all 5 cases pass.

- [ ] **Step 5: Full kernel test + typecheck**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
```
Expected: typecheck clean. 263 + 5 = 268 tests green. Pre-existing `queryEngineUsage.test.ts` and `queryEngineTruncate.test.ts` must remain green (their fake clients don't set requiresApproval so they don't hit the new branch).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-kernel/src/core/QueryEngine.ts \
        packages/agent-kernel/tests/core/queryEngine.approval.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): QueryEngine gates requiresApproval tools through coordinator

Before executeTool, if the tool's definition has requiresApproval=true
and a coordinator is configured, QueryEngine awaits gate(). Deny yields
a synthetic tool_result with error so the LLM sees the rejection and
keeps reasoning. The gate path is fully back-compat: tools without
requiresApproval (or no coordinator) take the original code path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Kernel — `browser/activeTabContext.ts` utility

**Files:**
- Create: `packages/agent-kernel/src/browser/activeTabContext.ts`
- Create: `packages/agent-kernel/tests/browser/activeTabContext.test.ts`
- Modify: `packages/agent-kernel/src/index.ts`(export)

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-kernel/tests/browser/activeTabContext.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildActiveTabApprovalContext } from 'agent-kernel'

// callChromeApi uses chrome.runtime.sendMessage broadcasts. Tests/setup.ts
// installs a chrome mock per package. We further patch chrome.tabs.query
// behavior by intercepting the broadcast.
//
// Simpler path: bypass the broadcast layer by stubbing `callChromeApi` at the
// module level via vi.doMock. But since kernel exports buildActiveTabApprovalContext
// directly, we mock chrome.runtime.sendMessage at runtime.

declare const chrome: any

describe('buildActiveTabApprovalContext', () => {
  let origSend: any
  beforeEach(() => {
    origSend = chrome.runtime.sendMessage
  })
  afterEach(() => {
    chrome.runtime.sendMessage = origSend
  })

  it('returns origin + url from active tab', async () => {
    // Mock the chrome_api_request broadcast: sw side responds with the tab list.
    chrome.runtime.sendMessage = vi.fn((msg: any) => {
      if (msg?.kind === 'chrome_api_request' && msg?.api === 'tabs.query') {
        // Simulate the result message coming back via broadcast.
        // domOpClient correlates by id. We invoke the response handler synchronously
        // through the listeners registered by callChromeApi.
        // Easiest: queue a microtask that fires the chrome.runtime.onMessage callback
        // with a matching id.
        queueMicrotask(() => {
          const listeners: any[] = chrome.runtime.onMessage.__listeners ?? []
          for (const l of listeners) {
            l({ kind: 'chrome_api_result', id: msg.id, ok: true, data: [{ url: 'https://example.com/path?q=1' }] })
          }
        })
      }
    })
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx.origin).toBe('https://example.com')
    expect(ctx.url).toBe('https://example.com/path?q=1')
  })

  it('returns empty object when no active tab', async () => {
    chrome.runtime.sendMessage = vi.fn((msg: any) => {
      if (msg?.kind === 'chrome_api_request' && msg?.api === 'tabs.query') {
        queueMicrotask(() => {
          const listeners: any[] = chrome.runtime.onMessage.__listeners ?? []
          for (const l of listeners) {
            l({ kind: 'chrome_api_result', id: msg.id, ok: true, data: [] })
          }
        })
      }
    })
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx).toEqual({})
  })

  it('returns url only when origin parse fails (about: / chrome: pages)', async () => {
    chrome.runtime.sendMessage = vi.fn((msg: any) => {
      if (msg?.kind === 'chrome_api_request' && msg?.api === 'tabs.query') {
        queueMicrotask(() => {
          const listeners: any[] = chrome.runtime.onMessage.__listeners ?? []
          for (const l of listeners) {
            l({ kind: 'chrome_api_result', id: msg.id, ok: true, data: [{ url: 'about:blank' }] })
          }
        })
      }
    })
    const ctx = await buildActiveTabApprovalContext()
    // about:blank has a valid origin in modern browsers ('null'), so URL() doesn't throw.
    // The test asserts behavior rather than expected: url is set, origin is whatever URL produces.
    expect(ctx.url).toBe('about:blank')
  })
})
```

**Important** — before writing the implementation, **inspect the existing `callChromeApi` test mock pattern**. Run:

```bash
grep -n "chrome.runtime.sendMessage\|chrome.runtime.onMessage" packages/agent-kernel/tests/setup.ts packages/agent-kernel/src/browser/offscreenChromePolyfill.ts 2>/dev/null | head -20
```

If the existing chrome mock provides a simpler way to stub `chrome.tabs.query`, USE THAT pattern instead of patching `chrome.runtime.sendMessage`. The test code above is a starting point — adjust to match existing mocks rather than fight them.

- [ ] **Step 2: Run tests to confirm fail**

```bash
cd packages/agent-kernel && bun run test tests/browser/activeTabContext.test.ts
```
Expected: FAIL — `buildActiveTabApprovalContext` not exported.

- [ ] **Step 3: Create `activeTabContext.ts`**

```ts
// packages/agent-kernel/src/browser/activeTabContext.ts
import { callChromeApi } from './domOpClient'
import type { ApprovalContext } from '../core/approval'

/**
 * Resolve the active tab's origin + url for use as ApprovalContext.
 *
 * Returns {} if no active tab or no url. Browser-extension utility — any
 * MV3 extension can use this verbatim, or compose it with its own
 * extension-specific context fields.
 */
export async function buildActiveTabApprovalContext(): Promise<ApprovalContext> {
  let tabs: unknown
  try {
    tabs = await callChromeApi('tabs.query', { active: true, currentWindow: true })
  } catch {
    return {}
  }
  const tab = (tabs as Array<{ url?: string }> | undefined)?.[0]
  const url = tab?.url
  if (!url) return {}
  let origin: string | undefined
  try {
    origin = new URL(url).origin
  } catch {
    /* opaque/about: tabs — fall through with only url */
  }
  return { url, ...(origin ? { origin } : {}) }
}
```

- [ ] **Step 4: Export from `index.ts`**

Add to the existing browser-section in `packages/agent-kernel/src/index.ts`:

```ts
export { buildActiveTabApprovalContext } from './browser/activeTabContext'
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
cd packages/agent-kernel && bun run test tests/browser/activeTabContext.test.ts
```
Expected: PASS. If the chrome mock interaction fails (test code didn't match how setup.ts mocks chrome), adjust the test to use the project's pattern — but **don't** change the implementation. The implementation is straightforward; only the test plumbing may need tweaks.

- [ ] **Step 6: Full kernel test + typecheck**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
```
Expected: 268 + 3 = 271 tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-kernel/src/browser/activeTabContext.ts \
        packages/agent-kernel/src/index.ts \
        packages/agent-kernel/tests/browser/activeTabContext.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): buildActiveTabApprovalContext browser utility

A small utility for browser-extension consumers: read the currently
active tab's origin/url for use as ApprovalContext. Lives in kernel/browser/
since it uses chrome.tabs (MV3-universal); any MV3 extension can compose
this with their own tool-specific context fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Kernel — `browser/agentService.ts` wires coordinator + routes `approval/reply`

**Files:**
- Modify: `packages/agent-kernel/src/browser/agentService.ts`(`AgentServiceDeps` 加 fields + 装配 + handle reply)
- Modify: `packages/agent-kernel/tests/browser/agentService.test.ts`(扩)

- [ ] **Step 1: Locate the existing test patterns**

Run:
```bash
grep -n "makeDeps\|agentEvents:\|approval/reply" packages/agent-kernel/tests/browser/agentService.test.ts | head -20
```

The file uses a `makeDeps` helper to build mock dependencies. Reuse it. You'll add 2-3 new cases.

- [ ] **Step 2: Write failing tests**

Append to `packages/agent-kernel/tests/browser/agentService.test.ts`:

```ts
import { ApprovalCoordinator, type ApprovalAdapter } from 'agent-kernel'

describe('agentService approval flow', () => {
  it('emits wire approval/requested when coordinator emits', async () => {
    // makeDeps is the existing helper; pass approvalAdapter in deps.
    const adapter: ApprovalAdapter = {
      check: async () => 'ask',
    }
    const { deps, events } = makeDeps({
      agentEvents: [
        { kind: 'message/streamChunk', delta: 'hi' },
        { kind: 'done', stopReason: 'end_turn', assistantText: 'hi' },
      ],
      approvalAdapter: adapter,
    })
    // Simulate a coordinator emit (would normally come from QueryEngine.gate).
    // Easiest: pull the coordinator out of agentService's wiring. Since agentService
    // constructs the coordinator itself, expose it via a deps callback or test hook.
    // SIMPLER PATH: assert via end-to-end. Skip emit-side test; cover via reply-routing test below.
    // (Delete this case if no easy injection point exists.)
  })

  it('routes wire approval/reply to coordinator.resolve', async () => {
    // Build a coordinator manually to test the wiring in isolation.
    const resolved: Array<{ id: string; decision: string }> = []
    const fakeCoord = {
      resolve: vi.fn((id: string, decision: string) => resolved.push({ id, decision })),
      cancelSession: vi.fn(),
    }
    // Pass via deps — agentService should use the provided coordinator instance
    // if deps.approvalCoordinator is set; otherwise construct one from deps.approvalAdapter.
    const { deps } = makeDeps({
      approvalCoordinator: fakeCoord as any,
    })
    const svc = createAgentService(deps as any)
    await svc.handleCommand?.({
      id: crypto.randomUUID(),
      sessionId: 's1',
      ts: Date.now(),
      kind: 'approval/reply',
      approvalId: 'a1',
      decision: 'session',
    } as any)
    expect(fakeCoord.resolve).toHaveBeenCalledWith('a1', 'session')
  })

  it('cancelSession is called when runTurn cancel is invoked', async () => {
    const fakeCoord = {
      resolve: vi.fn(),
      cancelSession: vi.fn(),
    }
    const { deps } = makeDeps({
      approvalCoordinator: fakeCoord as any,
      agentEvents: [{ kind: 'done', stopReason: 'cancel', assistantText: '' }],
    })
    const svc = createAgentService(deps as any)
    let cancel: (() => void) | undefined
    const turnP = svc.runTurn({ sessionId: 's1', text: 'q' }, (c) => { cancel = c })
    cancel?.()
    await turnP
    expect(fakeCoord.cancelSession).toHaveBeenCalledWith('s1', expect.any(String))
  })
})
```

**Note for the implementer:** the first `it('emits wire approval/requested ...')` case is exploratory — if the existing `makeDeps` doesn't easily allow injecting a real coordinator and reading its emit-side, **skip it** and rely on Task 8's end-to-end UI test to cover the emit path. The `routes wire approval/reply` and `cancelSession` cases are the must-haves.

Also the API surface used by tests (`handleCommand`, optional `approvalCoordinator`) may not yet exist — verify by reading current agentService.ts before writing tests.

- [ ] **Step 3: Inspect `agentService.ts` for command dispatch surface**

Run:
```bash
grep -n "kind === 'chat/\|kind === 'approval\|handleCommand\|ClientCmd" packages/agent-kernel/src/browser/agentService.ts | head -20
```

Find where `ClientCmd` is dispatched. Wire `approval/reply` there.

- [ ] **Step 4: Update `AgentServiceDeps` interface (`browser/agentService.ts`)**

Locate the `AgentServiceDeps` interface (~line 41). Add:

```ts
export interface AgentServiceDeps {
  // ...existing fields
  /** Adapter for approval decisions. If provided, agentService constructs
   *  an ApprovalCoordinator and wires it into QueryEngine. */
  approvalAdapter?: ApprovalAdapter
  /** Override the coordinator (used by tests). When provided, agentService
   *  uses this instance and ignores approvalAdapter. */
  approvalCoordinator?: ApprovalCoordinator
  /** Build ApprovalContext for each tool call. */
  buildApprovalContext?: (call: ToolCall) => ApprovalContext | Promise<ApprovalContext>
}
```

Add imports at top of file:
```ts
import {
  ApprovalCoordinator,
  type ApprovalAdapter,
  type ApprovalContext,
} from '../core/approval'
import type { ToolCall } from '../core/types'
```

- [ ] **Step 5: Wire coordinator construction + QueryEngine integration**

In `createAgentService` (where the QueryEngine / agent is built per turn), add coordinator construction:

```ts
// Inside createAgentService body, near where the agent is built per turn:

// Resolve the coordinator. Prefer explicit deps.approvalCoordinator (tests),
// else build one from deps.approvalAdapter.
const coordinator =
  deps.approvalCoordinator ??
  (deps.approvalAdapter
    ? new ApprovalCoordinator({
        adapter: deps.approvalAdapter,
        emit: (e) => {
          deps.emit({
            id: crypto.randomUUID(),
            sessionId: /* current sessionId */ '__pending__',  // see below
            ts: Date.now(),
            kind: 'approval/requested',
            approval: {
              id: e.approvalId,
              tool: e.req.tool,
              argsSummary: e.summary,
              origin: (e.req.ctx as any)?.origin,
            },
          })
        },
      })
    : undefined)
```

(The wire `approval/requested` event needs `sessionId` from envelope. The coordinator's emit hook doesn't know the current session out of the box; capture the sessionId via closure when runTurn is called and re-bind, OR store it on the coordinator. Simplest: defer this wiring to per-turn coordinator instances, OR keep one coordinator and have it pass sessionId from `gate()` into emit metadata.)

**Refined design** — pass `sessionId` through emit:

In `core/approval.ts`, change `emit` signature:

```ts
emit: (e: { approvalId: string; req: ApprovalRequest; summary: string; sessionId: string }) => void
```

And in `gate()`:

```ts
this.opts.emit({ approvalId, req, summary, sessionId })
```

Update the Task 1 test stubs accordingly:
- `emit` mock now receives a 4-field object — assertions need updating (`arg.sessionId` should be `'s1'` in test cases).
- **Action: if Task 1 already shipped without sessionId in emit, fix that here as part of Task 5** — extend the emit signature and propagate. Update the coordinator test cases to assert sessionId on emit.

Then agentService can use `e.sessionId`:

```ts
new ApprovalCoordinator({
  adapter: deps.approvalAdapter!,
  emit: (e) => {
    deps.emit({
      id: crypto.randomUUID(),
      sessionId: e.sessionId,
      ts: Date.now(),
      kind: 'approval/requested',
      approval: {
        id: e.approvalId,
        tool: e.req.tool,
        argsSummary: e.summary,
        origin: typeof e.req.ctx?.origin === 'string' ? (e.req.ctx.origin as string) : undefined,
      },
    })
  },
})
```

Pass coordinator + builder into QueryEngine where the engine is constructed in `runTurn`:

```ts
const engine = new QueryEngine({
  // ...existing
  approvalCoordinator: coordinator,
  sessionId: cmd.sessionId,
  buildApprovalContext: deps.buildApprovalContext,
  toolDefinitions: tools,  // pass the ToolDefinition[] so engine can look up requiresApproval
})
```

- [ ] **Step 6: Wire `approval/reply` command dispatch**

In the command handler (where `chat/send`, `chat/cancel` etc. are dispatched), add:

```ts
} else if (cmd.kind === 'approval/reply') {
  if (coordinator) {
    coordinator.resolve(cmd.approvalId, cmd.decision)
  } else {
    console.warn('[agentService] approval/reply received but no coordinator configured')
  }
}
```

- [ ] **Step 7: Wire cancelSession on turn cancel**

In the existing cancel handler / abort handler:

```ts
// when turn cancels:
coordinator?.cancelSession(cmd.sessionId, 'turn cancelled')
```

- [ ] **Step 8: Run tests to confirm pass**

```bash
cd packages/agent-kernel && bun run test tests/browser/agentService.test.ts
cd packages/agent-kernel && bun run test tests/core/approval/coordinator.test.ts
```
Expected: agentService.test new cases pass. Coordinator tests pass (with the sessionId-in-emit update).

- [ ] **Step 9: Full kernel test + typecheck + consumer build**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
cd ../mycli-web && bun run test
cd ../mycli-web && bun run build
```
Expected: all green. Consumer build still produces `dist/`.

- [ ] **Step 10: Commit**

```bash
git add packages/agent-kernel/src/browser/agentService.ts \
        packages/agent-kernel/src/core/approval.ts \
        packages/agent-kernel/tests/browser/agentService.test.ts \
        packages/agent-kernel/tests/core/approval/coordinator.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): agentService wires ApprovalCoordinator + routes wire reply

AgentServiceDeps now accepts approvalAdapter (or approvalCoordinator
directly for tests) + buildApprovalContext. Per-turn QueryEngine
gets the coordinator wired. Wire approval/reply commands route to
coordinator.resolve. Turn cancellation calls coordinator.cancelSession.

Adjusted coordinator.emit signature to include sessionId so agentService
can build the wire envelope correctly without extra closure plumbing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Consumer — `mycliApprovalAdapter`

**Files:**
- Create: `packages/mycli-web/src/extension/mycliApprovalAdapter.ts`
- Create: `packages/mycli-web/tests/extension/mycliApprovalAdapter.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/mycli-web/tests/extension/mycliApprovalAdapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mycliApprovalAdapter } from '@ext/mycliApprovalAdapter'
import { addRule, listRules } from '@ext/storage/rules'

declare const chrome: any

beforeEach(async () => {
  // setup.ts wipes chrome.storage between tests automatically — confirm by
  // listing rules first.
  await chrome.storage.local.clear?.()
})

describe('mycliApprovalAdapter.check', () => {
  it('returns ask when no rule matches', async () => {
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: { origin: 'https://example.com' },
    })
    expect(res).toBe('ask')
  })

  it('returns allow when a matching origin rule exists', async () => {
    await addRule({
      tool: 'readPage',
      scope: { kind: 'origin', origin: 'https://example.com' },
      decision: 'allow',
    })
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: { origin: 'https://example.com' },
    })
    expect(res).toBe('allow')
  })

  it('returns deny when matching deny rule', async () => {
    await addRule({
      tool: 'readPage',
      scope: { kind: 'global' },
      decision: 'deny',
    })
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: {},
    })
    expect(res).toBe('deny')
  })

  it('different origin does not match', async () => {
    await addRule({
      tool: 'readPage',
      scope: { kind: 'origin', origin: 'https://example.com' },
      decision: 'allow',
    })
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: { origin: 'https://other.com' },
    })
    expect(res).toBe('ask')
  })
})

describe('mycliApprovalAdapter.recordRule', () => {
  it('writes an origin-scoped rule when ctx.origin is present', async () => {
    await mycliApprovalAdapter.recordRule!(
      { tool: 'readPage', args: {}, ctx: { origin: 'https://example.com' } },
      'allow',
    )
    const rules = await listRules()
    expect(rules).toHaveLength(1)
    expect(rules[0].tool).toBe('readPage')
    expect(rules[0].scope).toEqual({ kind: 'origin', origin: 'https://example.com' })
    expect(rules[0].decision).toBe('allow')
  })

  it('writes a global rule when ctx.origin is missing', async () => {
    await mycliApprovalAdapter.recordRule!(
      { tool: 'readPage', args: {}, ctx: {} },
      'allow',
    )
    const rules = await listRules()
    expect(rules[0].scope).toEqual({ kind: 'global' })
  })
})
```

- [ ] **Step 2: Run tests to confirm fail**

```bash
cd packages/mycli-web && bun run test tests/extension/mycliApprovalAdapter.test.ts
```
Expected: FAIL — `@ext/mycliApprovalAdapter` not found.

- [ ] **Step 3: Create `mycliApprovalAdapter.ts`**

```ts
// packages/mycli-web/src/extension/mycliApprovalAdapter.ts
import type { ApprovalAdapter } from 'agent-kernel'
import { findMatchingRule, addRule } from './storage/rules'

export const mycliApprovalAdapter: ApprovalAdapter = {
  async check({ tool, ctx }) {
    const rule = await findMatchingRule({
      tool,
      origin: typeof ctx.origin === 'string' ? ctx.origin : undefined,
      selector: typeof ctx.selector === 'string' ? ctx.selector : undefined,
      url: typeof ctx.url === 'string' ? ctx.url : undefined,
    })
    if (!rule) return 'ask'
    return rule.decision  // 'allow' | 'deny'
  },
  async recordRule({ tool, ctx }, decision) {
    const origin = typeof ctx.origin === 'string' ? ctx.origin : undefined
    await addRule({
      tool,
      scope: origin ? { kind: 'origin', origin } : { kind: 'global' },
      decision,
    })
  },
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd packages/mycli-web && bun run test tests/extension/mycliApprovalAdapter.test.ts
```
Expected: 6 cases pass.

- [ ] **Step 5: Full consumer test**

```bash
cd packages/mycli-web && bun run test
```
Expected: 34 + 6 = 40 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/mycli-web/src/extension/mycliApprovalAdapter.ts \
        packages/mycli-web/tests/extension/mycliApprovalAdapter.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(consumer): mycliApprovalAdapter bridges kernel to rules.ts

Reference ApprovalAdapter implementation for mycli-web. check() reads
matching rules; recordRule() persists with origin-scoped fallback to
global. Kept thin — all rule semantics live in storage/rules.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Consumer — `approvalContextBuilder` (composes kernel utility)

**Files:**
- Create: `packages/mycli-web/src/extension/approvalContextBuilder.ts`
- Create: `packages/mycli-web/tests/extension/approvalContextBuilder.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/mycli-web/tests/extension/approvalContextBuilder.test.ts
import { describe, it, expect, vi } from 'vitest'

// We mock the kernel utility so this test is fast & deterministic.
vi.mock('agent-kernel', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    buildActiveTabApprovalContext: vi
      .fn()
      .mockResolvedValue({ origin: 'https://example.com', url: 'https://example.com/page' }),
  }
})

import { buildApprovalContext } from '@ext/approvalContextBuilder'

describe('buildApprovalContext', () => {
  it('returns kernel-utility result for non-selector tools', async () => {
    const ctx = await buildApprovalContext({ id: 'c1', name: 'readPage', input: {} })
    expect(ctx).toEqual({ origin: 'https://example.com', url: 'https://example.com/page' })
  })

  it('adds selector from args for querySelector-style tools', async () => {
    const ctx = await buildApprovalContext({
      id: 'c1',
      name: 'querySelector',
      input: { selector: '.btn' },
    })
    expect(ctx).toEqual({
      origin: 'https://example.com',
      url: 'https://example.com/page',
      selector: '.btn',
    })
  })

  it('does not add selector field if args.selector is not a string', async () => {
    const ctx = await buildApprovalContext({ id: 'c1', name: 'readPage', input: { selector: 42 } })
    expect('selector' in ctx).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to confirm fail**

```bash
cd packages/mycli-web && bun run test tests/extension/approvalContextBuilder.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `approvalContextBuilder.ts`**

```ts
// packages/mycli-web/src/extension/approvalContextBuilder.ts
import { buildActiveTabApprovalContext } from 'agent-kernel'
import type { ApprovalContext, ToolCall } from 'agent-kernel'

/**
 * mycli-web's ApprovalContext builder: kernel's active-tab utility + selector
 * extraction (mycli-web-specific because tool names that carry selectors are
 * a mycli-web convention).
 */
export async function buildApprovalContext(call: ToolCall): Promise<ApprovalContext> {
  const base = await buildActiveTabApprovalContext()
  const selector = (call.input as { selector?: unknown })?.selector
  if (typeof selector === 'string') {
    return { ...base, selector }
  }
  return base
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd packages/mycli-web && bun run test tests/extension/approvalContextBuilder.test.ts
```
Expected: 3 cases pass.

- [ ] **Step 5: Full consumer test + typecheck**

```bash
bun run typecheck
cd packages/mycli-web && bun run test
```
Expected: 40 + 3 = 43 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/mycli-web/src/extension/approvalContextBuilder.ts \
        packages/mycli-web/tests/extension/approvalContextBuilder.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(consumer): approvalContextBuilder composes kernel utility + selector

Wraps kernel's buildActiveTabApprovalContext and adds selector extraction
for mycli-web tools (querySelector / readSelection style). Selector
extraction is mycli-web-specific (depends on tool naming) so stays in
consumer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Consumer — `ApprovalModal` UI + mount + agent wiring

**Files:**
- Create: `packages/mycli-web/src/extension/ui/ApprovalModal.tsx`
- Modify: existing UI entry that owns ChatWindow (`packages/mycli-web/src/extension/content/` or `packages/mycli-web/src/extension/ui/`) — mount `<ApprovalModal />` alongside ChatWindow
- Modify: `bootKernelOffscreen` call site(`packages/mycli-web/src/extension/offscreen.ts` 或类似)— pass adapter + builder
- Create: `packages/mycli-web/tests/extension/ui/ApprovalModal.test.tsx`

- [ ] **Step 1: Locate the UI entry**

Run:
```bash
grep -rn "ChatWindow\b" packages/mycli-web/src/extension/content packages/mycli-web/src/extension/ui 2>/dev/null | head -10
grep -rn "bootKernelOffscreen" packages/mycli-web/src/extension/ 2>/dev/null | head -10
```

Find where ChatWindow is rendered and where bootKernelOffscreen is called.

- [ ] **Step 2: Write failing test for `ApprovalModal`**

```tsx
// packages/mycli-web/tests/extension/ui/ApprovalModal.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ApprovalModal } from '@ext/ui/ApprovalModal'

describe('ApprovalModal', () => {
  it('renders nothing when no pending approval', () => {
    render(<ApprovalModal pending={null} onReply={() => {}} />)
    expect(screen.queryByText(/approval needed/i)).toBeNull()
  })

  it('renders tool name, argsSummary, and origin when pending', () => {
    render(
      <ApprovalModal
        pending={{
          approvalId: 'a1',
          tool: 'readPage',
          argsSummary: 'Read https://example.com',
          origin: 'https://example.com',
        }}
        onReply={() => {}}
      />,
    )
    expect(screen.getByText(/readPage/i)).toBeInTheDocument()
    expect(screen.getByText(/Read https:\/\/example.com/)).toBeInTheDocument()
    expect(screen.getByText(/example.com/i)).toBeInTheDocument()
  })

  it('calls onReply with correct decision on each button', () => {
    const onReply = vi.fn()
    render(
      <ApprovalModal
        pending={{ approvalId: 'a1', tool: 't', argsSummary: 's', origin: undefined }}
        onReply={onReply}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^once$/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'once')
    fireEvent.click(screen.getByRole('button', { name: /this session/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'session')
    fireEvent.click(screen.getByRole('button', { name: /always/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'always')
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'deny')
  })

  it('Esc key triggers deny', () => {
    const onReply = vi.fn()
    render(
      <ApprovalModal
        pending={{ approvalId: 'a1', tool: 't', argsSummary: 's', origin: undefined }}
        onReply={onReply}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onReply).toHaveBeenLastCalledWith('a1', 'deny')
  })
})
```

If `@testing-library/react` is not in the consumer's devDependencies, install it first:

```bash
cd packages/mycli-web && bun add -d @testing-library/react @testing-library/jest-dom
```

Then ensure `tests/setup.ts` enables jsdom (likely already does — verify by checking `vitest.config.ts` for `environment: 'jsdom'`).

- [ ] **Step 3: Run tests to confirm fail**

```bash
cd packages/mycli-web && bun run test tests/extension/ui/ApprovalModal.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 4: Create `ApprovalModal.tsx`**

```tsx
// packages/mycli-web/src/extension/ui/ApprovalModal.tsx
import { useEffect } from 'react'

export interface PendingApproval {
  approvalId: string
  tool: string
  argsSummary: string
  origin?: string
}

export interface ApprovalModalProps {
  pending: PendingApproval | null
  onReply: (approvalId: string, decision: 'once' | 'session' | 'always' | 'deny') => void
}

export function ApprovalModal({ pending, onReply }: ApprovalModalProps) {
  useEffect(() => {
    if (!pending) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onReply(pending.approvalId, 'deny')
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pending, onReply])

  if (!pending) return null

  return (
    <div
      role="dialog"
      aria-label="Approval needed"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 999999,
      }}
    >
      <div
        style={{
          background: 'white',
          padding: 24,
          borderRadius: 8,
          maxWidth: 480,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h3 style={{ margin: '0 0 12px' }}>Approval needed</h3>
        <p style={{ margin: '4px 0' }}>
          <strong>Tool:</strong> {pending.tool}
        </p>
        <p style={{ margin: '4px 0' }}>
          <strong>Action:</strong> {pending.argsSummary}
        </p>
        {pending.origin && (
          <p style={{ margin: '4px 0' }}>
            <strong>Origin:</strong> {pending.origin}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button onClick={() => onReply(pending.approvalId, 'once')}>Once</button>
          <button onClick={() => onReply(pending.approvalId, 'session')}>This Session</button>
          <button onClick={() => onReply(pending.approvalId, 'always')}>Always</button>
          <button onClick={() => onReply(pending.approvalId, 'deny')}>Deny</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
cd packages/mycli-web && bun run test tests/extension/ui/ApprovalModal.test.tsx
```
Expected: 4 cases pass.

- [ ] **Step 6: Mount `<ApprovalModal />` into ChatWindow**

In the content-script entry that mounts `<ChatWindow />` (file located in Step 1), add a wrapper component that:

1. Subscribes to RPC events of `kind === 'approval/requested'` and updates a `pending` state
2. Renders `<ApprovalModal pending={pending} onReply={(id, decision) => { rpc.send({ kind: 'approval/reply', approvalId: id, decision }); setPending(null) }} />`

Pseudo-code (the implementer adapts to the actual file's wiring style):

```tsx
function ChatWindowWithApproval({ rpc }: { rpc: RpcClient }) {
  const [pending, setPending] = useState<PendingApproval | null>(null)
  useEffect(() => {
    const unsub = rpc.onEvent((ev: any) => {
      if (ev.kind === 'approval/requested') {
        setPending({
          approvalId: ev.approval.id,
          tool: ev.approval.tool,
          argsSummary: ev.approval.argsSummary,
          origin: ev.approval.origin,
        })
      }
    })
    return unsub
  }, [rpc])
  return (
    <>
      <ChatWindow rpc={rpc} />
      <ApprovalModal
        pending={pending}
        onReply={(id, decision) => {
          rpc.send({ kind: 'approval/reply', approvalId: id, decision })
          setPending(null)
        }}
      />
    </>
  )
}
```

The exact integration depends on the existing component shape — implementer reads the file and adapts.

- [ ] **Step 7: Wire adapter + builder into `bootKernelOffscreen` call**

In `packages/mycli-web/src/extension/offscreen.ts` (or wherever `bootKernelOffscreen({ tools, ... })` is called):

```ts
import { mycliApprovalAdapter } from './mycliApprovalAdapter'
import { buildApprovalContext } from './approvalContextBuilder'

bootKernelOffscreen({
  // ...existing
  approvalAdapter: mycliApprovalAdapter,
  buildApprovalContext,
})
```

(`bootKernelOffscreen` may forward these to `agentService` automatically because of the deps interface; verify by reading the helper, and if it doesn't forward, add the forwarding.)

- [ ] **Step 8: Verify build + manual smoke**

```bash
bun run typecheck
cd packages/mycli-web && bun run test
cd packages/mycli-web && bun run build
```
Expected: typecheck clean, consumer tests pass (43 + 4 = 47), `packages/mycli-web/dist/` produced.

Manual smoke (optional, requires Chrome):
1. Load `packages/mycli-web/dist/` as an unpacked extension
2. Open any web page
3. Mark a tool like `readPage` with `requiresApproval: true` in its definition (do this in the ToolDefinition export, **as a separate code change** decided with user — NOT this task's scope)
4. Send a chat that triggers the tool → modal appears → click any button → flow continues

This step's commit does **not** mark any specific tool as `requiresApproval` — that's user-level config we agreed in spec to defer.

- [ ] **Step 9: Commit**

```bash
git add packages/mycli-web/src/extension/ui/ApprovalModal.tsx \
        packages/mycli-web/tests/extension/ui/ApprovalModal.test.tsx \
        packages/mycli-web/src/extension/offscreen.ts \
        packages/mycli-web/src/extension/content/  # whichever entry was edited
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(consumer): ApprovalModal UI + wire kernel adapter

Shadow-DOM React modal subscribes to 'approval/requested' events and
sends back 'approval/reply' commands. Plumbs mycliApprovalAdapter and
buildApprovalContext into bootKernelOffscreen so any tool with
requiresApproval=true now goes through the user.

This commit does NOT mark any specific tool as requiresApproval — that
is per-tool config left for follow-up (decided in spec).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full-stack verification + handoff

**Files:**
- Create: `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-12-approval-flow.md`

- [ ] **Step 1: Full repo verification**

From worktree root:
```bash
bun run typecheck
cd packages/agent-kernel && bun run test
cd ../mycli-web && bun run test
cd ../mycli-web && bun run build
```

Record numbers:
- kernel: expected ~271+ tests green (depending on Task 4 test count)
- consumer: expected ~47 tests green
- build: dist/ produced

Save the test counts.

- [ ] **Step 2: Verify portability claim**

Verify that `packages/agent-kernel/src/core/` files do not import from `chrome`, `chrome.*`, `document`, `window`, or any mycli-web module:

```bash
grep -rn "chrome\.\|from 'chrome'\|document\.\|window\.\|@ext/" packages/agent-kernel/src/core/ | grep -v '\.test\.' || echo "core is clean"
```

Expected: `core is clean` (no matches outside test files).

Verify `packages/agent-kernel/src/browser/` does not import from mycli-web:

```bash
grep -rn "@ext/\|from 'mycli-web\|packages/mycli-web" packages/agent-kernel/src/browser/ || echo "browser is mycli-clean"
```

Expected: `browser is mycli-clean`.

If either check fails, fix the offending import before committing the handoff.

- [ ] **Step 3: Write handoff**

Create `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-12-approval-flow.md`. Match the style of `HANDOFF-2026-05-10-skills.md` and `HANDOFF-2026-05-12-prompt-cache-observability.md`. Sections:

1. **一句话总结** — kernel-level approval flow done, mycli-web adapter + UI wired, test counts
2. **跑了什么** — 9 tasks, commit SHAs from `git log --oneline -15` (filter to feat(kernel)/feat(consumer)/test(consumer))
3. **如何试一下** — option A: kernel unit tests cover the chain (mention specific test files); option B: load extension, mark `readPage` `requiresApproval: true`, send a chat
4. **改了哪些文件** — kernel core/ files, kernel browser/ files, consumer files
5. **跨浏览器扩展可迁移性** — note that any MV3 extension can: implement ApprovalAdapter + UI listener for approval/requested → reply. Reference `buildActiveTabApprovalContext` as the kernel-shipped utility.
6. **已知问题** — no tool is marked requiresApproval yet (per spec); rule management UI is a separate spec; abort during pending hasn't been live-tested
7. **下一步** — sub-projects #3-#5 from brainstorming: Plan + TodoWrite, Sub-agent / Fork, 多 Tab 编排

Get SHAs from `git log --oneline -15`.

- [ ] **Step 4: Commit handoff**

```bash
git add packages/mycli-web/docs/superpowers/HANDOFF-2026-05-12-approval-flow.md
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "docs: handoff for user approval flow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Final sanity check**

```bash
git log --oneline -12
```

Expected: 9 implementation commits + handoff + spec/plan commits visible. Worktree clean (`git status` empty except pre-existing unrelated diffs).

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| ApprovalCoordinator + types | T1 |
| ToolDefinition fields | T1 |
| QueryEngine integration | T3 |
| Core protocol Zod | T2 |
| Browser activeTabContext utility | T4 |
| agentService装配 + reply routing | T5 |
| Consumer adapter | T6 |
| Consumer context builder | T7 |
| Consumer UI + mount + agent wiring | T8 |
| Tests | every task |
| Portability claim | T9 |
| Handoff | T9 |
| Out-of-scope (rule management UI, requiresApproval per-tool config) | acknowledged in T8 commit message |

**Placeholder scan:** Re-read…
- T5 has "(filename location depends on existing wiring)" style hints, but each is paired with `grep` commands to discover concrete paths — acceptable. Implementer reads code first.
- T8 step 6 has pseudo-code for the wrapper component, with an explicit "implementer adapts to the actual file's wiring style." Same pattern as T8's `bootKernelOffscreen` step 7. Acceptable for UI-integration tasks where the existing file shape matters more than the spec.

**Type consistency:**
- `ApprovalCoordinator.emit` signature: in T1 it was `{ approvalId, req, summary }`, but T5 step 5 says "extend to include sessionId". This is a **mid-plan refactor** — flagged explicitly in T5 step 5 with instructions to update the Task 1 tests retroactively in the same Task 5 commit. The Task 1 commit will momentarily ship a `gate()` that calls emit with the 3-field shape, then T5 updates both call site and tests in one commit. Documented in the commit message. Acceptable trade-off; alternative was building Task 1 already with sessionId, but reviewer wouldn't see why until reading Task 5. Either way works; chose to keep Task 1 readable in isolation.
- `ApprovalAdapter.recordRule(req, decision)` is consistent across T1 + T6.
- `buildApprovalContext` signature: `(call: ToolCall) => ApprovalContext | Promise<ApprovalContext>` — consistent across T3, T5, T7.
- `ApprovalContext` is `Record<string, unknown>` — consistent everywhere.

No dangling references found. Plan locked.
