# Sub-agent / Fork 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 mycli-web 主 agent 能通过 `Task` tool 派生独立子 agent,以 kernel-first 原则把机制下沉到 agent-kernel,让任何浏览器扩展 consumer 都能复用。

**Architecture:** kernel 在 `core/subagent/` 新增 `SubagentType` 注册形状、`Subagent` 运行器(复用 `QueryEngine`)、`Task` tool 工厂;通过 `bootKernelOffscreen({ subagentTypes })` 选项装配。子 agent 用独立 `subagentId` 作 `conversationId`,通过 ctx 上新增的 `emitSubagentEvent` 把内部 message/tool_call/tool_end 流以新增的 5 个 `AgentEvent` 变体广播到 UI。mycli-web 注册 1 个 reference 类型 `general-purpose`,Shadow-DOM 内渲染可展开 `SubagentCard`。

**Tech Stack:** TypeScript、Bun workspace、Vitest、Zod、IndexedDB、React (Shadow DOM)。

**Spec 偏差说明(写 plan 时发现的 1 处需要调整)**:
- 设计稿 §4.1 `subagent/message` 字段写的是 `content: ContentBlock[]`,但 agent-kernel 现实里没有 `ContentBlock` 类型,且现有的 `assistant/iter` 事件用 `text: string`。v1 对齐既有模式,**`subagent/message` 用 `text: string` 字段**,以后想扩 block 数组再加 `content?: ContentPart[]`,不破坏 wire schema。

---

## 文件结构

### kernel 新增 / 修改

| 路径 | 责任 | 任务 |
|---|---|---|
| `packages/agent-kernel/src/core/types.ts` | 扩 `ToolExecContext`:加 `turnId?`、`callId?`、`subagentId?`、`emitSubagentEvent?`;新增 `SubagentId` brand 类型 | T1 |
| `packages/agent-kernel/src/core/AgentSession.ts:55-67` | executeTool 闭包内 ctx 加入 `callId: call.id` | T1 |
| `packages/agent-kernel/src/browser/agentService.ts:383-389` | `fullCtx` 加入 `turnId`(新生成 uuid)和 `emitSubagentEvent`(包 wire envelope 后调 deps.emit) | T1 |
| `packages/agent-kernel/src/core/subagent/SubagentType.ts` | `SubagentType` 接口 + `SubagentTypeRegistry` + `buildSubagentTypeRegistry` | T2 |
| `packages/agent-kernel/src/core/protocol.ts` | 加 5 个 `AgentEvent` 变体(`subagent/started` 等) | T3 |
| `packages/agent-kernel/src/core/subagent/Subagent.ts` | `Subagent` 类(单次运行器)+ `SubagentFailedError` | T4 |
| `packages/agent-kernel/src/core/subagent/taskTool.ts` | `buildTaskTool` 工厂 | T5 |
| `packages/agent-kernel/src/core/subagent/index.ts` | 公共 re-export | T5 |
| `packages/agent-kernel/src/core/index.ts` | 顶层 re-export `SubagentType`、`SubagentId` | T5 |
| `packages/agent-kernel/src/browser/rpc/protocol.ts` | wire 端 5 个变体(套 envelope) | T6 |
| `packages/agent-kernel/src/browser/bootKernelOffscreen.ts` | 接受 `subagentTypes` 选项;非空数组时构造 Task tool 加入 tools | T7 |

### kernel 测试新增

| 测试文件 | 任务 |
|---|---|
| `packages/agent-kernel/tests/core/toolExecContext.test.ts` | T1 |
| `packages/agent-kernel/tests/core/subagent/SubagentType.test.ts` | T2 |
| `packages/agent-kernel/tests/core/subagent/protocol.test.ts` | T3 |
| `packages/agent-kernel/tests/core/subagent/Subagent.test.ts` | T4 |
| `packages/agent-kernel/tests/core/subagent/taskTool.test.ts` | T5 |
| `packages/agent-kernel/tests/browser/rpc/protocol.subagent.test.ts` | T6 |
| `packages/agent-kernel/tests/browser/bootKernelOffscreen.subagent.test.ts` | T7 |

### consumer (mycli-web) 新增 / 修改

| 路径 | 责任 | 任务 |
|---|---|---|
| `packages/mycli-web/src/extension-tools/subagentTypes/generalPurpose.ts` | reference 类型 | T8 |
| `packages/mycli-web/src/extension-tools/subagentTypes/index.ts` | 聚合 + `allSubagentTypes` | T8 |
| `packages/mycli-web/src/extension/offscreen.ts` | `bootKernelOffscreen({ subagentTypes: allSubagentTypes })` | T8 |
| `packages/mycli-web/tests/extension-tools/subagentTypes.test.ts` | `allowedTools` 静态守护 | T8 |
| `packages/mycli-web/src/extension/ui/SubagentCard.tsx` | 子 agent 卡片 | T9 |
| `packages/mycli-web/src/extension/content/ChatApp.tsx` | 订阅 subagent/* 事件,维护两张 map | T9 |
| `packages/mycli-web/src/extension/ui/MessageList.tsx`(改) | Task tool_call 路由到 SubagentCard | T9 |
| `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-subagent-fork.md` | handoff 文档 | T10 |

---

### Task 1: 给 `ToolExecContext` 补 `turnId` / `callId` / `subagentId` / `emitSubagentEvent`

> **目的**:为 Task tool 提供必需的 ctx 字段。这是后续所有任务的前置。

**Files:**
- Modify: `packages/agent-kernel/src/core/types.ts:69-78`
- Modify: `packages/agent-kernel/src/core/AgentSession.ts:55-68`
- Modify: `packages/agent-kernel/src/browser/agentService.ts:383-389`
- Create: `packages/agent-kernel/tests/core/toolExecContext.test.ts`

- [ ] **Step 1: 写测试 — types.ts 编译态验证 + AgentSession 行为**

创建 `packages/agent-kernel/tests/core/toolExecContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AgentSession } from '../../src/core/AgentSession'
import { ToolRegistry } from '../../src/core/ToolRegistry'
import type { ToolDefinition, ToolExecContext } from '../../src/core/types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

describe('ToolExecContext extension', () => {
  it('exposes optional turnId / callId / subagentId / emitSubagentEvent fields (type check)', () => {
    // Compile-time check — TS will fail if fields are missing.
    const ctx: ToolExecContext = {
      turnId: 't-1',
      callId: 'c-1',
      subagentId: 's-1' as any,
      emitSubagentEvent: () => {},
    }
    expect(ctx.turnId).toBe('t-1')
    expect(ctx.callId).toBe('c-1')
  })

  it('AgentSession populates ctx.callId from ToolCall.id when executing tools', async () => {
    let observedCtx: ToolExecContext | null = null
    const probe: ToolDefinition<{ x: number }, string> = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      async execute(_input, ctx) {
        observedCtx = ctx
        return { ok: true, data: 'ok' }
      },
    }
    const registry = new ToolRegistry([probe])

    // Scripted LLM: one assistant turn emits a tool_use; second turn ends.
    const llmClient: OpenAICompatibleClient = {
      async *streamChat() {
        // Yield a tool_use then done.
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'call-XYZ', name: 'probe', input: { x: 1 } }],
        } as any
      },
    } as any

    const session = new AgentSession({
      llmClient,
      registry,
      toolContext: { turnId: 'turn-ABC' } as any,
    })

    // Drain the iterator (one iter is enough to hit the tool path).
    const it = session.send('hi')
    // Pump through at most 5 events to keep the test bounded.
    for (let i = 0; i < 5; i++) {
      const next = await it.next()
      if (next.done) break
    }

    expect(observedCtx).not.toBeNull()
    expect((observedCtx as any).callId).toBe('call-XYZ')
    expect((observedCtx as any).turnId).toBe('turn-ABC')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
bun --cwd packages/agent-kernel run test tests/core/toolExecContext.test.ts
```

预期:第一个测试 TS 编译错误(`turnId` 不在 `ToolExecContext` 上);若注释掉则第二个测试 fail —— `observedCtx.callId` 是 undefined。

- [ ] **Step 3: 改 `core/types.ts` 的 `ToolExecContext`**

把现有 lines 69-78 改为:

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** Branded uuid identifying a single sub-agent run. */
export type SubagentId = string & { readonly __brand: 'SubagentId' }

/** Forward declaration — full schema lives in core/protocol.ts. The execution
 *  context only needs the call signature, not the type body. */
export type SubagentEventInput = {
  kind:
    | 'subagent/started'
    | 'subagent/message'
    | 'subagent/tool_call'
    | 'subagent/tool_end'
    | 'subagent/finished'
  [k: string]: unknown
}

export interface ToolExecContext {
  signal?: AbortSignal
  /** Per-conversation todo store. Injected by agentService for tools that need it. */
  todoStore?: TodoStoreAdapter
  /** Active conversation id. Undefined for ephemeral turns. */
  conversationId?: ConversationId
  /** Stable id for the current main-agent turn. agentService generates one per
   *  runTurn. Sub-agents inherit (and override) via Task tool spawn. */
  turnId?: string
  /** Id of the in-flight ToolCall this execution corresponds to. Populated by
   *  AgentSession's executeTool closure. */
  callId?: string
  /** Present only when the current tool call is happening inside a sub-agent. */
  subagentId?: SubagentId
  /** Out-of-band emitter for sub-agent lifecycle events. Populated by
   *  agentService; tools that don't spawn sub-agents ignore this. */
  emitSubagentEvent?: (ev: SubagentEventInput) => void
}
```

- [ ] **Step 4: 改 `AgentSession.executeTool` 闭包**(`core/AgentSession.ts:55-68`)

把 lines 55-68(`executeTool: async (call: ToolCall) => { ... }`)改为:

```ts
      executeTool: async (call: ToolCall) => {
        const def = this.opts.registry.get(call.name)
        if (!def) {
          return {
            ok: false,
            error: { code: 'unknown_tool', message: call.name, retryable: false },
          }
        }
        // Build ctx from caller-provided ExtraCtx; AgentSession is the source
        // of truth for the per-call callId (the tool can't construct one).
        const ctx = {
          ...(this.opts.toolContext as object),
          callId: call.id,
        } as ToolExecContext & ExtraCtx
        return def.execute(call.input as any, ctx)
      },
```

- [ ] **Step 5: 改 `agentService.ts` `fullCtx` 构造**(lines 383-389)

把:

```ts
      const toolContext = await deps.toolContext.build(cid ?? undefined)
      // Augment with todo-related fields used by todoWriteTool
      const fullCtx = {
        ...toolContext,
        todoStore: deps.todoStore,
        conversationId: cid ?? undefined,
      }
```

改为:

```ts
      const toolContext = await deps.toolContext.build(cid ?? undefined)
      const turnId = crypto.randomUUID()
      // Augment with todo + subagent fields. emitSubagentEvent forwards
      // sub-agent lifecycle events through deps.emit with the wire envelope.
      const fullCtx = {
        ...toolContext,
        todoStore: deps.todoStore,
        conversationId: cid ?? undefined,
        turnId,
        emitSubagentEvent: (ev: any) => {
          deps.emit({
            id: crypto.randomUUID(),
            sessionId: cmd.sessionId,
            ts: Date.now(),
            ...ev,
          })
        },
      }
```

- [ ] **Step 6: 跑测试 + 全套 kernel 测试**

```bash
bun --cwd packages/agent-kernel run test tests/core/toolExecContext.test.ts
bun --cwd packages/agent-kernel run test
```

预期:全绿。

- [ ] **Step 7: commit**

```bash
git add packages/agent-kernel/src/core/types.ts \
        packages/agent-kernel/src/core/AgentSession.ts \
        packages/agent-kernel/src/browser/agentService.ts \
        packages/agent-kernel/tests/core/toolExecContext.test.ts
git commit -m "feat(kernel): ToolExecContext gains turnId/callId/subagentId/emitSubagentEvent"
```

---

### Task 2: `SubagentType` + registry 构造器

**Files:**
- Create: `packages/agent-kernel/src/core/subagent/SubagentType.ts`
- Create: `packages/agent-kernel/tests/core/subagent/SubagentType.test.ts`

- [ ] **Step 1: 写测试**

```ts
// packages/agent-kernel/tests/core/subagent/SubagentType.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildSubagentTypeRegistry,
  type SubagentType,
} from '../../../src/core/subagent/SubagentType'

const minimal = (name: string): SubagentType => ({
  name,
  description: 'd',
  systemPrompt: 's',
  allowedTools: '*',
})

describe('buildSubagentTypeRegistry', () => {
  it('returns empty map for empty array', () => {
    const r = buildSubagentTypeRegistry([])
    expect(r.size).toBe(0)
  })

  it('builds a Map keyed by name', () => {
    const r = buildSubagentTypeRegistry([minimal('alpha'), minimal('beta')])
    expect(r.size).toBe(2)
    expect(r.get('alpha')?.name).toBe('alpha')
    expect(r.get('beta')?.name).toBe('beta')
  })

  it('throws on duplicate names', () => {
    expect(() =>
      buildSubagentTypeRegistry([minimal('x'), minimal('x')]),
    ).toThrow(/duplicate/i)
  })

  it.each([
    ['Capital'],
    ['1leading-digit'],
    ['has space'],
    ['has_under$core'],
    [''],
  ])('throws on invalid name format: %s', (bad) => {
    expect(() => buildSubagentTypeRegistry([minimal(bad)])).toThrow(/name/i)
  })

  it('accepts valid names matching /^[a-z][a-z0-9_-]*$/', () => {
    expect(() =>
      buildSubagentTypeRegistry([
        minimal('a'),
        minimal('general-purpose'),
        minimal('explore_v2'),
      ]),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/SubagentType.test.ts
```

预期:`Cannot find module` 错误。

- [ ] **Step 3: 实现 `SubagentType.ts`**

```ts
// packages/agent-kernel/src/core/subagent/SubagentType.ts

export interface SubagentType {
  /** LLM-facing type name. Must match /^[a-z][a-z0-9_-]*$/. */
  readonly name: string
  /** 1–2 sentence summary shown in the Task tool description. */
  readonly description: string
  /** Sub-agent's system prompt. */
  readonly systemPrompt: string
  /** Whitelist of tool names. '*' = all parent tools minus Task. */
  readonly allowedTools: '*' | readonly string[]
  /** Override default maxIterations. */
  readonly maxIterations?: number
  /** Override the model name. Shares the parent's OpenAI client. */
  readonly model?: string
  /** Reserved for future concurrency control. v1 does NOT enforce. */
  readonly maxConcurrent?: number
}

export type SubagentTypeRegistry = ReadonlyMap<string, SubagentType>

const NAME_RE = /^[a-z][a-z0-9_-]*$/

export function buildSubagentTypeRegistry(
  types: readonly SubagentType[],
): SubagentTypeRegistry {
  const map = new Map<string, SubagentType>()
  for (const t of types) {
    if (!NAME_RE.test(t.name)) {
      throw new Error(
        `SubagentType: invalid name "${t.name}" — must match /^[a-z][a-z0-9_-]*$/`,
      )
    }
    if (map.has(t.name)) {
      throw new Error(`SubagentType: duplicate name "${t.name}"`)
    }
    map.set(t.name, t)
  }
  return map
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/SubagentType.test.ts
```

预期:全绿。

- [ ] **Step 5: commit**

```bash
git add packages/agent-kernel/src/core/subagent/SubagentType.ts \
        packages/agent-kernel/tests/core/subagent/SubagentType.test.ts
git commit -m "feat(kernel): SubagentType interface + buildSubagentTypeRegistry"
```

---

### Task 3: 5 个 `subagent/*` AgentEvent 变体(core 协议)

**Files:**
- Modify: `packages/agent-kernel/src/core/protocol.ts:104-135`
- Create: `packages/agent-kernel/tests/core/subagent/protocol.test.ts`

- [ ] **Step 1: 写测试**

```ts
// packages/agent-kernel/tests/core/subagent/protocol.test.ts
import { describe, it, expect } from 'vitest'
import { AgentEvent } from '../../../src/core/protocol'

describe('AgentEvent subagent/* variants', () => {
  it('parses subagent/started', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/started',
      subagentId: 's-1',
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      subagentType: 'general-purpose',
      description: 'do thing',
      prompt: 'go',
      startedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/message with text', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/message',
      subagentId: 's-1',
      text: 'hi',
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_call', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/tool_call',
      subagentId: 's-1',
      callId: 'c-2',
      toolName: 'readPage',
      args: { url: 'x' },
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_end (ok)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/tool_end',
      subagentId: 's-1',
      callId: 'c-2',
      ok: true,
      content: 'result',
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_end (error)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/tool_end',
      subagentId: 's-1',
      callId: 'c-2',
      ok: false,
      error: { code: 'x', message: 'y' },
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/finished (success)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/finished',
      subagentId: 's-1',
      ok: true,
      text: 'final',
      iterations: 3,
      finishedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/finished (failure)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/finished',
      subagentId: 's-1',
      ok: false,
      error: { code: 'aborted', message: '...' },
      iterations: 2,
      finishedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('rejects subagent/finished missing iterations', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/finished',
      subagentId: 's-1',
      ok: true,
      text: 'x',
      finishedAt: 1,
    })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/protocol.test.ts
```

预期:7 个 success-path 全 fail(`kind` enum 不接受新值)。

- [ ] **Step 3: 在 `core/protocol.ts` 加 5 个变体**

在 `TodoUpdated` 定义之后(line ~119)、`AgentEvent = z.discriminatedUnion(...)` 之前(line ~121),追加:

```ts
// --- Sub-agent / Fork events (see core/subagent/) ---

const SubagentStarted = z.object({
  kind: z.literal('subagent/started'),
  subagentId: z.string(),
  parentTurnId: z.string(),
  parentCallId: z.string(),
  subagentType: z.string(),
  description: z.string(),
  prompt: z.string(),
  startedAt: z.number().int().nonnegative(),
})

const SubagentMessage = z.object({
  kind: z.literal('subagent/message'),
  subagentId: z.string(),
  text: z.string(),
  ts: z.number().int().nonnegative(),
})

const SubagentToolCall = z.object({
  kind: z.literal('subagent/tool_call'),
  subagentId: z.string(),
  callId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  ts: z.number().int().nonnegative(),
})

const SubagentToolEnd = z.object({
  kind: z.literal('subagent/tool_end'),
  subagentId: z.string(),
  callId: z.string(),
  ok: z.boolean(),
  content: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  ts: z.number().int().nonnegative(),
})

const SubagentFinished = z.object({
  kind: z.literal('subagent/finished'),
  subagentId: z.string(),
  ok: z.boolean(),
  text: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  iterations: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
})
```

然后在 `AgentEvent = z.discriminatedUnion('kind', [...])` 数组里追加这 5 个,放在 `TodoUpdated` 之后:

```ts
export const AgentEvent = z.discriminatedUnion('kind', [
  StreamChunk,
  ToolStart,
  ToolEnd,
  Done,
  FatalError,
  Usage,
  AssistantIter,
  ApprovalRequested,
  TodoUpdated,
  SubagentStarted,
  SubagentMessage,
  SubagentToolCall,
  SubagentToolEnd,
  SubagentFinished,
  CompactStarted,
  CompactCompleted,
  CompactFailed,
])
```

- [ ] **Step 4: 跑测试验证通过**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/protocol.test.ts
bun --cwd packages/agent-kernel run test
```

预期:全绿。

- [ ] **Step 5: commit**

```bash
git add packages/agent-kernel/src/core/protocol.ts \
        packages/agent-kernel/tests/core/subagent/protocol.test.ts
git commit -m "feat(kernel): AgentEvent gains 5 subagent/* variants"
```

---

### Task 4: `Subagent` 运行器 + `SubagentFailedError`

> **目的**:把"跑一个子 agent"这个概念封装成可独立测试的类。复用 `QueryEngine`(不复用 `AgentSession`,因为 AgentSession 输出 AgentEvent 流是给主 turn 用的,子 agent 需要更细粒度地映射事件)。

**Files:**
- Create: `packages/agent-kernel/src/core/subagent/Subagent.ts`
- Create: `packages/agent-kernel/tests/core/subagent/Subagent.test.ts`

- [ ] **Step 1: 写测试 — 成功路径**

```ts
// packages/agent-kernel/tests/core/subagent/Subagent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Subagent, SubagentFailedError } from '../../../src/core/subagent/Subagent'
import type { SubagentType } from '../../../src/core/subagent/SubagentType'
import { ToolRegistry } from '../../../src/core/ToolRegistry'
import type {
  ToolDefinition,
  ToolExecContext,
  SubagentId,
  SubagentEventInput,
} from '../../../src/core/types'
import type { OpenAICompatibleClient } from '../../../src/core/OpenAICompatibleClient'

function makeLLM(script: Array<() => any>): OpenAICompatibleClient {
  let i = 0
  return {
    async *streamChat() {
      const step = script[i++]
      if (!step) throw new Error('script exhausted')
      yield* step()
    },
  } as any
}

const baseType: SubagentType = {
  name: 'gp',
  description: 'd',
  systemPrompt: 'You are a sub-agent.',
  allowedTools: '*',
  maxIterations: 5,
}

function makeProbe(name: string, result = 'r'): ToolDefinition<any, string> {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    async execute() {
      return { ok: true, data: result }
    },
  }
}

describe('Subagent.run', () => {
  it('returns assistant text on simple end_turn', async () => {
    const llm = makeLLM([
      async function* () {
        yield { kind: 'delta', text: 'hello world' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    ])
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-1' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'say hi',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([]),
      llm,
      emit: (ev) => events.push(ev),
    })
    const r = await sa.run()
    expect(r.text).toBe('hello world')
    expect(r.iterations).toBe(1)
    const kinds = events.map((e) => e.kind)
    expect(kinds[0]).toBe('subagent/started')
    expect(kinds[kinds.length - 1]).toBe('subagent/finished')
  })

  it('handles a tool-call iteration then final text', async () => {
    const llm = makeLLM([
      async function* () {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'tc-1', name: 'probe', input: {} }],
        }
      },
      async function* () {
        yield { kind: 'delta', text: 'done' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    ])
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-2' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([makeProbe('probe')]),
      llm,
      emit: (ev) => events.push(ev),
    })
    const r = await sa.run()
    expect(r.text).toBe('done')
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('subagent/tool_call')
    expect(kinds).toContain('subagent/tool_end')
  })

  it('throws SubagentFailedError max_iterations_no_result when only tool calls', async () => {
    const llm = makeLLM([
      async function* () {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'a', name: 'probe', input: {} }],
        }
      },
      async function* () {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'b', name: 'probe', input: {} }],
        }
      },
    ])
    const typ = { ...baseType, maxIterations: 2 }
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-3' as SubagentId,
      type: typ,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([makeProbe('probe')]),
      llm,
      emit: (ev) => events.push(ev),
    })
    await expect(sa.run()).rejects.toMatchObject({
      name: 'SubagentFailedError',
      code: 'max_iterations_no_result',
    })
    const last = events[events.length - 1]
    expect(last.kind).toBe('subagent/finished')
    expect((last as any).ok).toBe(false)
  })

  it('throws SubagentFailedError llm_error when LLM throws', async () => {
    const llm: any = {
      async *streamChat() {
        throw new Error('boom')
      },
    }
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-4' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([]),
      llm,
      emit: (ev) => events.push(ev),
    })
    await expect(sa.run()).rejects.toMatchObject({
      code: 'llm_error',
    })
  })

  it('aborts when parent signal aborts', async () => {
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((res) => (resolveStarted = res))
    const llm: any = {
      async *streamChat({ signal }: any) {
        resolveStarted()
        await new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('AbortError'))))
      },
    }
    const ac = new AbortController()
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-5' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: ac.signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([]),
      llm,
      emit: (ev) => events.push(ev),
    })
    const p = sa.run()
    await started
    ac.abort()
    await expect(p).rejects.toBeDefined()
    const fin = events.find((e) => e.kind === 'subagent/finished') as any
    expect(fin?.ok).toBe(false)
  })

  it('filters out Task tool from child registry even when allowedTools is "*"', async () => {
    const taskTool = makeProbe('Task')
    const visibleNames: string[] = []
    const llm: any = {
      async *streamChat({ tools }: any) {
        for (const t of tools ?? []) visibleNames.push(t.function.name)
        yield { kind: 'delta', text: 'ok' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    }
    const sa = new Subagent({
      id: 'sid-6' as SubagentId,
      type: { ...baseType, allowedTools: '*' },
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([taskTool, makeProbe('probe')]),
      llm,
      emit: () => {},
    })
    await sa.run()
    expect(visibleNames).toContain('probe')
    expect(visibleNames).not.toContain('Task')
  })

  it('restricts child tools to allowedTools whitelist', async () => {
    const visibleNames: string[] = []
    const llm: any = {
      async *streamChat({ tools }: any) {
        for (const t of tools ?? []) visibleNames.push(t.function.name)
        yield { kind: 'delta', text: 'ok' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    }
    const sa = new Subagent({
      id: 'sid-7' as SubagentId,
      type: { ...baseType, allowedTools: ['probe'] },
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([makeProbe('probe'), makeProbe('other')]),
      llm,
      emit: () => {},
    })
    await sa.run()
    expect(visibleNames).toEqual(['probe'])
  })

  it('uses subagentId as ToolExecContext.conversationId for child tool calls', async () => {
    let observedCid: string | undefined
    const probe: ToolDefinition<any, string> = {
      name: 'probe',
      description: '',
      inputSchema: { type: 'object' },
      async execute(_input, ctx) {
        observedCid = ctx.conversationId
        return { ok: true, data: 'x' }
      },
    }
    const llm: any = {
      async *streamChat() {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'tc-1', name: 'probe', input: {} }],
        }
      },
    }
    let i = 0
    const llm2: any = {
      async *streamChat() {
        if (i++ === 0) {
          yield {
            kind: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'tc-1', name: 'probe', input: {} }],
          }
        } else {
          yield { kind: 'delta', text: 'done' }
          yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
        }
      },
    }
    const sid = 'sid-8' as SubagentId
    const sa = new Subagent({
      id: sid,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: { conversationId: 'parent-cid' as any } as ToolExecContext,
      registry: new ToolRegistry([probe]),
      llm: llm2,
      emit: () => {},
    })
    await sa.run()
    expect(observedCid).toBe(sid)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/Subagent.test.ts
```

预期:`Cannot find module './subagent/Subagent'`。

- [ ] **Step 3: 实现 `Subagent.ts`**

```ts
// packages/agent-kernel/src/core/subagent/Subagent.ts
import { QueryEngine } from '../QueryEngine'
import { ToolRegistry } from '../ToolRegistry'
import type {
  ToolCall,
  ToolDefinition,
  ToolExecContext,
  ToolResult,
  SubagentId,
  SubagentEventInput,
} from '../types'
import type { OpenAICompatibleClient } from '../OpenAICompatibleClient'
import type { SubagentType } from './SubagentType'

export type SubagentEvent = SubagentEventInput

export interface SubagentRunOptions {
  readonly id: SubagentId
  readonly type: SubagentType
  readonly parentTurnId: string
  readonly parentCallId: string
  readonly userPrompt: string
  readonly userDescription: string
  readonly parentSignal: AbortSignal
  readonly parentCtx: ToolExecContext
  readonly registry: ToolRegistry
  readonly llm: OpenAICompatibleClient
  readonly emit: (ev: SubagentEvent) => void
}

export interface SubagentRunResult {
  readonly text: string
  readonly iterations: number
}

export type SubagentFailureCode =
  | 'max_iterations_no_result'
  | 'llm_error'
  | 'subagent_failed'

export class SubagentFailedError extends Error {
  readonly name = 'SubagentFailedError'
  constructor(
    readonly code: SubagentFailureCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

const TASK_TOOL_NAME = 'Task'

export class Subagent {
  constructor(private opts: SubagentRunOptions) {}

  async run(): Promise<SubagentRunResult> {
    const { id, type, parentSignal, emit } = this.opts

    // Child abort controller — abort whenever the parent does.
    const child = new AbortController()
    const onParentAbort = () => child.abort(parentSignal.reason)
    if (parentSignal.aborted) {
      child.abort(parentSignal.reason)
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }

    // Build filtered registry: drop Task tool always; apply whitelist if any.
    const allTools = this.opts.registry.all()
    const allowed = type.allowedTools
    const visible: ToolDefinition<any, any, any>[] = allTools.filter((t) => {
      if (t.name === TASK_TOOL_NAME) return false
      if (allowed === '*') return true
      return allowed.includes(t.name)
    })
    const childRegistry = new ToolRegistry(visible)

    // Build child ToolExecContext.
    const childCtx: ToolExecContext = {
      ...this.opts.parentCtx,
      signal: child.signal,
      conversationId: id as unknown as string as any,
      turnId: this.opts.parentTurnId,
      subagentId: id,
      emitSubagentEvent: emit,
    }

    const startedAt = Date.now()
    emit({
      kind: 'subagent/started',
      subagentId: id,
      parentTurnId: this.opts.parentTurnId,
      parentCallId: this.opts.parentCallId,
      subagentType: type.name,
      description: this.opts.userDescription,
      prompt: this.opts.userPrompt,
      startedAt,
    })

    const engine = new QueryEngine({
      client: this.opts.llm,
      tools: childRegistry.toOpenAi(),
      executeTool: async (call: ToolCall): Promise<ToolResult> => {
        const def = childRegistry.get(call.name)
        if (!def) {
          return {
            ok: false,
            error: { code: 'unknown_tool', message: call.name, retryable: false },
          }
        }
        const callCtx = { ...childCtx, callId: call.id }
        return def.execute(call.input as any, callCtx)
      },
      toolMaxIterations: type.maxIterations,
      systemPrompt: type.systemPrompt,
      signal: child.signal,
      toolDefinitions: childRegistry.all(),
    })

    let lastAssistantText = ''
    let iterations = 0
    let stopReason: string = 'end_turn'
    let errorFromEngine: { code: string; message: string } | undefined

    try {
      for await (const ev of engine.run([{ role: 'user', content: this.opts.userPrompt }])) {
        if (ev.kind === 'assistant_message_complete') {
          iterations++
          if (ev.text) {
            lastAssistantText = ev.text
            emit({
              kind: 'subagent/message',
              subagentId: id,
              text: ev.text,
              ts: Date.now(),
            })
          }
        } else if (ev.kind === 'tool_executing') {
          emit({
            kind: 'subagent/tool_call',
            subagentId: id,
            callId: ev.call.id,
            toolName: ev.call.name,
            args: ev.call.input,
            ts: Date.now(),
          })
        } else if (ev.kind === 'tool_result') {
          emit({
            kind: 'subagent/tool_end',
            subagentId: id,
            callId: ev.callId,
            ok: !ev.isError,
            content: ev.content,
            ts: Date.now(),
          })
        } else if (ev.kind === 'done') {
          stopReason = ev.stopReason
          errorFromEngine = ev.error
        }
      }
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort as any)
    }

    const finishedAt = Date.now()

    if (child.signal.aborted) {
      emit({
        kind: 'subagent/finished',
        subagentId: id,
        ok: false,
        error: { code: 'aborted', message: 'Sub-agent aborted' },
        iterations,
        finishedAt,
      })
      throw new SubagentFailedError('subagent_failed', 'Sub-agent aborted')
    }

    if (stopReason === 'error') {
      const code = errorFromEngine?.code ?? 'llm_error'
      const msg = errorFromEngine?.message ?? 'LLM error'
      emit({
        kind: 'subagent/finished',
        subagentId: id,
        ok: false,
        error: { code, message: msg },
        iterations,
        finishedAt,
      })
      throw new SubagentFailedError('llm_error', msg)
    }

    if (stopReason === 'max_iterations' && !lastAssistantText) {
      emit({
        kind: 'subagent/finished',
        subagentId: id,
        ok: false,
        error: { code: 'max_iterations_no_result', message: 'Sub-agent hit max iterations without a final answer' },
        iterations,
        finishedAt,
      })
      throw new SubagentFailedError(
        'max_iterations_no_result',
        'Sub-agent hit max iterations without a final answer',
      )
    }

    emit({
      kind: 'subagent/finished',
      subagentId: id,
      ok: true,
      text: lastAssistantText,
      iterations,
      finishedAt,
    })
    return { text: lastAssistantText, iterations }
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/Subagent.test.ts
```

预期:全部测试通过。若 abort 测试 flaky,允许它 reject 但不强制 error 类型(留意:某些 stream 实现 abort 是抛 DOMException,代码已 catch in finally 块 → child.signal.aborted 检查)。

- [ ] **Step 5: 跑全套 kernel 测试**

```bash
bun --cwd packages/agent-kernel run test
```

预期:全绿。

- [ ] **Step 6: commit**

```bash
git add packages/agent-kernel/src/core/subagent/Subagent.ts \
        packages/agent-kernel/tests/core/subagent/Subagent.test.ts
git commit -m "feat(kernel): Subagent runner + SubagentFailedError"
```

---

### Task 5: `Task` tool 工厂 + subagent index re-exports

**Files:**
- Create: `packages/agent-kernel/src/core/subagent/taskTool.ts`
- Create: `packages/agent-kernel/src/core/subagent/index.ts`
- Modify: `packages/agent-kernel/src/core/index.ts`(re-export 顶层)
- Create: `packages/agent-kernel/tests/core/subagent/taskTool.test.ts`

- [ ] **Step 1: 写测试**

```ts
// packages/agent-kernel/tests/core/subagent/taskTool.test.ts
import { describe, it, expect } from 'vitest'
import { buildTaskTool } from '../../../src/core/subagent/taskTool'
import { buildSubagentTypeRegistry } from '../../../src/core/subagent/SubagentType'
import { ToolRegistry } from '../../../src/core/ToolRegistry'
import type { SubagentType } from '../../../src/core/subagent/SubagentType'
import type { ToolDefinition, ToolExecContext, SubagentEventInput } from '../../../src/core/types'

const gp: SubagentType = {
  name: 'general-purpose',
  description: 'GP agent',
  systemPrompt: 'sys',
  allowedTools: '*',
}
const explore: SubagentType = {
  name: 'explore',
  description: 'Read-only',
  systemPrompt: 'sys',
  allowedTools: ['probe'],
}

const dummyLLM: any = {
  async *streamChat() {
    yield { kind: 'delta', text: 'done' }
    yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
  },
}

describe('buildTaskTool', () => {
  it('description lists all registered types with their descriptions', () => {
    const reg = buildSubagentTypeRegistry([gp, explore])
    const t = buildTaskTool(reg, dummyLLM)
    expect(t.description).toContain('general-purpose')
    expect(t.description).toContain('explore')
    expect(t.description).toContain('GP agent')
    expect(t.description).toContain('Read-only')
    expect(t.description.toLowerCase()).toContain('cannot nest')
  })

  it('input schema enum contains all type names', () => {
    const reg = buildSubagentTypeRegistry([gp, explore])
    const t = buildTaskTool(reg, dummyLLM)
    const enumValues = (t.inputSchema as any).properties.subagent_type.enum
    expect(enumValues).toEqual(['general-purpose', 'explore'])
  })

  it('execute returns ok with subagent final text', async () => {
    const reg = buildSubagentTypeRegistry([gp])
    const t = buildTaskTool(reg, dummyLLM)
    const events: SubagentEventInput[] = []
    const ctx: ToolExecContext = {
      signal: new AbortController().signal,
      turnId: 't-1',
      callId: 'c-1',
      emitSubagentEvent: (ev) => events.push(ev),
    }
    // Provide a parent registry through ctx (the Task tool resolves it via
    // ctx.__taskParentRegistry — see Subagent integration).
    ;(ctx as any).__taskParentRegistry = new ToolRegistry([])
    const r = await t.execute(
      { subagent_type: 'general-purpose', description: 'd', prompt: 'p' },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBe('done')
    expect(events[0].kind).toBe('subagent/started')
  })

  it('execute returns error when subagent fails', async () => {
    const reg = buildSubagentTypeRegistry([gp])
    const failingLLM: any = {
      async *streamChat() {
        throw new Error('boom')
      },
    }
    const t = buildTaskTool(reg, failingLLM)
    const ctx: ToolExecContext = {
      signal: new AbortController().signal,
      turnId: 't-1',
      callId: 'c-1',
      emitSubagentEvent: () => {},
    }
    ;(ctx as any).__taskParentRegistry = new ToolRegistry([])
    const r = await t.execute(
      { subagent_type: 'general-purpose', description: 'd', prompt: 'p' },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('subagent_failed')
      expect(r.error.message).toContain('general-purpose failed')
      expect(r.error.retryable).toBe(false)
    }
  })

  it('execute requires ctx.turnId / callId / emitSubagentEvent', async () => {
    const reg = buildSubagentTypeRegistry([gp])
    const t = buildTaskTool(reg, dummyLLM)
    const ctx: ToolExecContext = { signal: new AbortController().signal }
    ;(ctx as any).__taskParentRegistry = new ToolRegistry([])
    const r = await t.execute(
      { subagent_type: 'general-purpose', description: 'd', prompt: 'p' },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('subagent_ctx_missing')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/taskTool.test.ts
```

预期:`Cannot find module './subagent/taskTool'`。

- [ ] **Step 3: 实现 `taskTool.ts`**

```ts
// packages/agent-kernel/src/core/subagent/taskTool.ts
import { Subagent, SubagentFailedError } from './Subagent'
import type { SubagentTypeRegistry } from './SubagentType'
import { makeOk, makeError } from '../Tool'
import type { ToolDefinition, ToolExecContext, SubagentId } from '../types'
import type { OpenAICompatibleClient } from '../OpenAICompatibleClient'
import { ToolRegistry } from '../ToolRegistry'

interface TaskInput {
  subagent_type: string
  description: string
  prompt: string
}

function buildDescription(registry: SubagentTypeRegistry): string {
  const lines: string[] = []
  lines.push('Spawns a sub-agent to handle a focused sub-task with isolated context.')
  lines.push('')
  lines.push('Available types:')
  for (const t of registry.values()) {
    lines.push(`- ${t.name}: ${t.description}`)
  }
  lines.push('')
  lines.push(
    'Use the Task tool when a sub-task is well-defined and self-contained, ' +
      "especially if you'd otherwise pollute your own context with intermediate steps. " +
      'You cannot nest Task calls.',
  )
  return lines.join('\n')
}

export function buildTaskTool(
  registry: SubagentTypeRegistry,
  llm: OpenAICompatibleClient,
): ToolDefinition<TaskInput, string> {
  const typeNames = Array.from(registry.keys())
  return {
    name: 'Task',
    description: buildDescription(registry),
    inputSchema: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', enum: typeNames },
        description: { type: 'string', minLength: 1, maxLength: 120 },
        prompt: { type: 'string', minLength: 1 },
      },
      required: ['subagent_type', 'description', 'prompt'],
    },
    async execute(input, ctx) {
      if (!ctx.turnId || !ctx.callId || !ctx.emitSubagentEvent) {
        return makeError(
          'subagent_ctx_missing',
          'Task tool requires ctx.turnId, ctx.callId and ctx.emitSubagentEvent',
          false,
        )
      }
      const type = registry.get(input.subagent_type)
      if (!type) {
        return makeError(
          'unknown_subagent_type',
          `Unknown subagent_type "${input.subagent_type}"`,
          false,
        )
      }

      const parentRegistry: ToolRegistry =
        (ctx as any).__taskParentRegistry ?? new ToolRegistry([])

      const sid = (crypto.randomUUID() as unknown) as SubagentId
      const parentSignal = ctx.signal ?? new AbortController().signal

      const sub = new Subagent({
        id: sid,
        type,
        parentTurnId: ctx.turnId,
        parentCallId: ctx.callId,
        userPrompt: input.prompt,
        userDescription: input.description,
        parentSignal,
        parentCtx: ctx,
        registry: parentRegistry,
        llm,
        emit: ctx.emitSubagentEvent,
      })

      try {
        const result = await sub.run()
        return makeOk(result.text)
      } catch (e) {
        if (e instanceof SubagentFailedError) {
          return makeError(
            'subagent_failed',
            `Subagent ${type.name} failed: ${e.message}. The sub-task was not completed.`,
            false,
          )
        }
        // AbortError or other unexpected
        if (parentSignal.aborted) throw e
        return makeError(
          'subagent_failed',
          `Subagent ${type.name} failed: ${(e as Error)?.message ?? String(e)}. The sub-task was not completed.`,
          false,
        )
      }
    },
  }
}
```

- [ ] **Step 4: 实现 `core/subagent/index.ts`**

```ts
// packages/agent-kernel/src/core/subagent/index.ts
export {
  buildSubagentTypeRegistry,
  type SubagentType,
  type SubagentTypeRegistry,
} from './SubagentType'
export { buildTaskTool } from './taskTool'
export { Subagent, SubagentFailedError } from './Subagent'
```

- [ ] **Step 5: 顶层 re-export(`core/index.ts`)**

在 `packages/agent-kernel/src/core/index.ts` 末尾追加(若没有就照下面写一行):

```ts
export type { SubagentId } from './types'
export {
  buildSubagentTypeRegistry,
  buildTaskTool,
  type SubagentType,
  type SubagentTypeRegistry,
} from './subagent'
```

> 若 `core/index.ts` 已有 `export *` 风格,把新 file 加入相应位置即可 —— 用 grep 自查后再插入。

- [ ] **Step 6: 跑 taskTool 测试 + 全 kernel 套件**

```bash
bun --cwd packages/agent-kernel run test tests/core/subagent/taskTool.test.ts
bun --cwd packages/agent-kernel run test
bun run typecheck
```

预期:全绿。

- [ ] **Step 7: commit**

```bash
git add packages/agent-kernel/src/core/subagent/taskTool.ts \
        packages/agent-kernel/src/core/subagent/index.ts \
        packages/agent-kernel/src/core/index.ts \
        packages/agent-kernel/tests/core/subagent/taskTool.test.ts
git commit -m "feat(kernel): Task tool factory + subagent module re-exports"
```

---

### Task 6: wire 端 5 个 `subagent/*` 变体

**Files:**
- Modify: `packages/agent-kernel/src/browser/rpc/protocol.ts`
- Create: `packages/agent-kernel/tests/browser/rpc/protocol.subagent.test.ts`

- [ ] **Step 1: 看现有 wire envelope 风格**

```bash
grep -n "todo/updated\|TodoUpdated" packages/agent-kernel/src/browser/rpc/protocol.ts | head -5
```

预期:能找到一个现有 wire schema 块(类似 `WireTodoUpdated`),作为模板。

- [ ] **Step 2: 写测试**

```ts
// packages/agent-kernel/tests/browser/rpc/protocol.subagent.test.ts
import { describe, it, expect } from 'vitest'
import { AgentEvent } from '../../../src/browser/rpc/protocol'

const envelope = {
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  ts: 1,
}

describe('wire AgentEvent — subagent/* variants', () => {
  it('parses subagent/started', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/started',
      subagentId: 'sid',
      parentTurnId: 't',
      parentCallId: 'c',
      subagentType: 'gp',
      description: 'd',
      prompt: 'p',
      startedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/message', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/message',
      subagentId: 'sid',
      text: 'hi',
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_call', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/tool_call',
      subagentId: 'sid',
      callId: 'c2',
      toolName: 'readPage',
      args: {},
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_end', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/tool_end',
      subagentId: 'sid',
      callId: 'c2',
      ok: true,
      content: 'r',
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/finished', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/finished',
      subagentId: 'sid',
      ok: true,
      text: 'fin',
      iterations: 1,
      finishedAt: 2,
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试验证失败**

```bash
bun --cwd packages/agent-kernel run test tests/browser/rpc/protocol.subagent.test.ts
```

预期:5 个测试全 fail(union 不接受新 kind)。

- [ ] **Step 4: 改 `browser/rpc/protocol.ts`**

先在文件里看 `TodoUpdated` 模式怎么写的(grep 出来作 reference)。然后照同样风格在 `AgentEvent` discriminated union 上加 5 个新 wire schema。在已有 wire schema 定义区(`const Wire*` 们)和 union 数组里**两处都要加**。

参考模板(基于 core schema + envelope 字段 `id`、`sessionId`、`ts`):

```ts
const WireSubagentStarted = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal('subagent/started'),
  subagentId: z.string(),
  parentTurnId: z.string(),
  parentCallId: z.string(),
  subagentType: z.string(),
  description: z.string(),
  prompt: z.string(),
  startedAt: z.number().int().nonnegative(),
})

const WireSubagentMessage = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal('subagent/message'),
  subagentId: z.string(),
  text: z.string(),
})

const WireSubagentToolCall = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal('subagent/tool_call'),
  subagentId: z.string(),
  callId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
})

const WireSubagentToolEnd = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal('subagent/tool_end'),
  subagentId: z.string(),
  callId: z.string(),
  ok: z.boolean(),
  content: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

const WireSubagentFinished = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal('subagent/finished'),
  subagentId: z.string(),
  ok: z.boolean(),
  text: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  iterations: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
})
```

把这 5 个加入现有的 `AgentEvent = z.discriminatedUnion('kind', [...])` 数组。

> **注意**:envelope 字段名必须与该文件已有的其他 Wire schema **完全一致**。grep `WireTodoUpdated` 确认风格;若发现 envelope 字段叫别的(比如 `sessionId` 是必须 uuid 格式),沿用 — 不要发明。

- [ ] **Step 5: 跑测试验证通过**

```bash
bun --cwd packages/agent-kernel run test tests/browser/rpc/protocol.subagent.test.ts
bun --cwd packages/agent-kernel run test
```

预期:全绿。

- [ ] **Step 6: commit**

```bash
git add packages/agent-kernel/src/browser/rpc/protocol.ts \
        packages/agent-kernel/tests/browser/rpc/protocol.subagent.test.ts
git commit -m "feat(kernel): wire AgentEvent gains 5 subagent/* variants"
```

---

### Task 7: `bootKernelOffscreen` 接受 `subagentTypes` + 装配 Task tool

> **关键**:Task tool 是**动态构造**的(因为 description / enum 依赖 registry);而且它需要 access 当前 turn 的 parent registry,以便从主 toolRegistry 派生 child registry。我们通过 `__taskParentRegistry` ctx 后门把它递进 Task tool(在 agentService 构造 fullCtx 时塞入)。

**Files:**
- Modify: `packages/agent-kernel/src/browser/bootKernelOffscreen.ts`
- Modify: `packages/agent-kernel/src/browser/agentService.ts`(在 fullCtx 中加 `__taskParentRegistry`)
- Create: `packages/agent-kernel/tests/browser/bootKernelOffscreen.subagent.test.ts`

- [ ] **Step 1: 看 agentService 怎么构造 ToolRegistry**

```bash
grep -n "new ToolRegistry\|allTools" packages/agent-kernel/src/browser/agentService.ts | head -5
```

确认 agentService 内部有一个 `allTools` array 或一个 `ToolRegistry` 实例 — 后面要把它塞入 `__taskParentRegistry`。

- [ ] **Step 2: 写测试**

```ts
// packages/agent-kernel/tests/browser/bootKernelOffscreen.subagent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bootKernelOffscreen } from '../../src/browser/bootKernelOffscreen'
import type { SubagentType } from '../../src/core/subagent/SubagentType'

const stubAdapters = () => ({
  settings: {
    get: async () => ({
      apiKey: 'k',
      baseUrl: 'http://x',
      model: 'm',
      systemPromptAddendum: '',
      toolMaxIterations: 5,
      toolMaxOutputChars: 1000,
    }),
    set: async () => {},
    subscribe: () => () => {},
  } as any,
  messageStore: {
    list: async () => [],
    append: async () => ({ id: 'm-1' }),
    update: async () => {},
    activeConversationId: async () => undefined,
  } as any,
  toolContext: { build: async () => ({}) } as any,
})

let toolNamesSeen: string[] = []

const fakeCreateAgent = (opts: any) => {
  toolNamesSeen = (opts.tools as any[]).map((t: any) => t.name)
  return { cancel: () => {}, async *send() {} } as any
}

beforeEach(() => {
  toolNamesSeen = []
  ;(globalThis as any).chrome = {
    runtime: { onConnect: { addListener: () => {} } },
    storage: { session: { setAccessLevel: () => {} } },
  }
})

const gp: SubagentType = {
  name: 'general-purpose',
  description: 'GP',
  systemPrompt: 's',
  allowedTools: '*',
}

describe('bootKernelOffscreen with subagentTypes', () => {
  it('omitted → Task tool not registered', async () => {
    const a = stubAdapters()
    bootKernelOffscreen({ ...a, createAgent: fakeCreateAgent })
    // Need to actually trigger a runTurn to inspect tools. Easier path:
    // intercept allTools via createAgent's tools param. Since bootKernel only
    // builds tools when runTurn fires, we hook agentService directly. The
    // simpler assertion here: tools array passed to agentService excludes Task.
    // We accept the test scope and assert the API contract via createAgent
    // being called when send() runs; for now, snapshot the constructed tools.
    // Pragmatic check: bootKernelOffscreen builds `tools` array internally;
    // we'll verify via a runTurn round-trip in a separate integration test if
    // needed. For unit: assert no throw and confirm tools list (when runTurn
    // wired) excludes Task by inspecting agentService's tools.
    expect(toolNamesSeen).not.toContain('Task')
  })

  it('empty array → Task tool not registered', async () => {
    const a = stubAdapters()
    bootKernelOffscreen({
      ...a,
      createAgent: fakeCreateAgent,
      subagentTypes: [],
    })
    expect(toolNamesSeen).not.toContain('Task')
  })

  it('non-empty → Task tool registered', async () => {
    const a = stubAdapters()
    bootKernelOffscreen({
      ...a,
      createAgent: fakeCreateAgent,
      subagentTypes: [gp],
    })
    // The actual registration check needs runTurn — we instead validate the
    // public effect: an exposed predicate (see below) reports the tool list.
    // For now we trust the implementation contract verified in Subagent /
    // taskTool unit tests and add a smoke check that bootKernel does not throw.
  })
})
```

> **写测试时的现实**:`bootKernelOffscreen` 是 sync function、没有 runTurn 入口;真正断言"Task 是否在 tools 中"需要触发 `chat/send`。**实施建议**:把上面 3 个测试改成 **走过 chat/send 一次**(用脚本化 LLM 输出 end_turn 即可),然后 spy `fakeCreateAgent`,检查它收到的 `tools` 数组里是否包含 `Task`。具体接线见 step 4 — 如果觉得太复杂,把这个测试改名为 "smoke" 并仅断言"bootKernel 不抛"。但**核心断言一定要包含至少一次 createAgent 调用并检查 tools**,否则这个测试没价值。

- [ ] **Step 3: 实现 — 改 `bootKernelOffscreen.ts`**

(1) 在 `BootKernelOffscreenOptions` 加字段:

```ts
import type { SubagentType } from '../core/subagent/SubagentType'
import { buildSubagentTypeRegistry, buildTaskTool } from '../core/subagent'
import { OpenAICompatibleClient as LLMClient } from '../core/OpenAICompatibleClient'

export interface BootKernelOffscreenOptions {
  // ...existing fields
  /** Optional sub-agent type registry. Non-empty array → registers Task tool. */
  subagentTypes?: readonly SubagentType[]
}
```

(2) 在 `tools` 数组构造之后(line ~111),追加 Task tool 注册逻辑:

```ts
  const todoEnabled = opts.todoStore !== null
  const tools = todoEnabled
    ? [...(opts.tools ?? []), todoWriteTool]
    : [...(opts.tools ?? [])]

  // Sub-agent / Fork: register Task tool when at least one type is declared.
  const subagentTypes = opts.subagentTypes ?? []
  if (subagentTypes.length > 0) {
    const registry = buildSubagentTypeRegistry(subagentTypes)
    // Build a lazy LLM client — the actual settings are read per-turn inside
    // agentService, so we construct a thin client here that fetches from
    // SettingsAdapter on demand. Simpler: defer to agentService by passing the
    // registry through deps and letting agentService build the Task tool with
    // the live LLM client on each turn. We choose the simpler path:
    //   - Task tool factory is called once at boot with a *placeholder* LLM
    //     client (the real one is recreated per-turn by agentService).
    //   - The Task tool itself reads the LLM at execute() time via a closure
    //     we set up below.
    // For v1 we accept the simpler model: agentService is the one calling
    // buildTaskTool — see agentService changes.
    ;(opts as any).__subagentTypeRegistry = registry
  }
```

(3) 把 registry 通过 createAgentService deps 透传:

```ts
  const agentService = createAgentService({
    settings: opts.settings,
    emit,
    messageStore: opts.messageStore,
    toolContext: opts.toolContext,
    tools,
    createAgent: opts.createAgent,
    approvalAdapter: opts.approvalAdapter,
    buildApprovalContext: opts.buildApprovalContext,
    todoStore: resolvedTodoStore,
    subagentTypeRegistry: subagentTypes.length > 0
      ? buildSubagentTypeRegistry(subagentTypes)
      : undefined,
  } as any)
```

- [ ] **Step 4: 实现 — 改 `agentService.ts`**

(1) `AgentServiceDeps` 加字段:

```ts
import type { SubagentTypeRegistry } from '../core/subagent/SubagentType'
import { buildTaskTool } from '../core/subagent/taskTool'
import { ToolRegistry } from '../core/ToolRegistry'

export interface AgentServiceDeps {
  // ...existing
  subagentTypeRegistry?: SubagentTypeRegistry
}
```

(2) 在 `runTurn` 内构造 tools 之前(找到现有 `const filteredTools = ...` 行),先把 Task tool 拼进去(若 registry 非空):

```ts
      // ...existing fullCtx construction (T1 已完成)

      // Build the per-turn LLM client. Existing code already constructs it
      // when calling createAgent below — we need access to it before that to
      // pass into the Task tool factory.
      const llmClient = /* reuse existing settings → client construction */
        // If existing code instantiates the client inline inside createAgent
        // call, refactor to construct it here first.
        new OpenAICompatibleClient({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: cmd.model ?? settings.model,
        })

      // Augment tools with Task when a registry is configured.
      const baseTools = deps.tools ?? []
      const finalTools = deps.subagentTypeRegistry
        ? [...baseTools, buildTaskTool(deps.subagentTypeRegistry, llmClient)]
        : baseTools

      const filteredTools = cmd.tools
        ? finalTools.filter((t) => cmd.tools!.includes(t.name))
        : finalTools

      // Expose parent registry to the Task tool via ctx back-door so it can
      // derive the child's filtered registry.
      const parentRegistry = new ToolRegistry(finalTools)
      ;(fullCtx as any).__taskParentRegistry = parentRegistry
```

> **重要**:看 `agentService.ts` 现状,LLM client 可能是在 `createAgent` 内部构造的(`createAgent` 接 `llm: { apiKey, baseUrl, model }` 配置 — 见 line 397-402)。这种情况下 **agentService 需要重构一行**:把 LLM client 构造提到 `createAgent` 调用之前(用 `new OpenAICompatibleClient(...)`),然后把 client 实例同时传给 `createAgent`(若 `createAgent` 支持注入)和 `buildTaskTool`。具体接线在实施 task 时按现状调整 —— 看一眼 `createAgent` 的签名再决定:
> - 若 `createAgent` 接受 `llmClient` 而不是 `{ apiKey, ... }`,直接复用同一实例。
> - 若不接受,在 `createAgent` 那里加一个 `llmClient?` 选项作为优先级更高的注入路径,fallback 到构造原配置。
> - **实现细节这里不展开**,因为依赖 `createAgent` 当前签名。implementer 自己看代码定。

- [ ] **Step 5: 跑测试 + 全套**

```bash
bun --cwd packages/agent-kernel run test
bun run typecheck
```

预期:全绿。新测试通过。

- [ ] **Step 6: portability 守护**

确认 kernel 新增代码:
- `core/subagent/` 下零 `chrome.` 引用
- `browser/` 下零 `mycli` / `@ext` 引用
- 任何浏览器扩展按 README 给的接线方式都能用 Task tool

```bash
grep -rn "chrome\." packages/agent-kernel/src/core/subagent/ && echo "FAIL: core has chrome.*" || echo "OK: core is clean"
grep -rn "mycli\|@ext" packages/agent-kernel/src/browser/ && echo "FAIL: browser has mycli refs" || echo "OK: browser is mycli-clean"
```

两条都应该是 OK。

- [ ] **Step 7: commit**

```bash
git add packages/agent-kernel/src/browser/bootKernelOffscreen.ts \
        packages/agent-kernel/src/browser/agentService.ts \
        packages/agent-kernel/tests/browser/bootKernelOffscreen.subagent.test.ts
git commit -m "feat(kernel): bootKernelOffscreen wires subagentTypes + Task tool per turn"
```

---

### Task 8: consumer reference 类型 `general-purpose` + offscreen 接线

**Files:**
- Create: `packages/mycli-web/src/extension-tools/subagentTypes/generalPurpose.ts`
- Create: `packages/mycli-web/src/extension-tools/subagentTypes/index.ts`
- Modify: `packages/mycli-web/src/extension/offscreen.ts`
- Create: `packages/mycli-web/tests/extension-tools/subagentTypes.test.ts`

- [ ] **Step 1: 写守护测试**

```ts
// packages/mycli-web/tests/extension-tools/subagentTypes.test.ts
import { describe, it, expect } from 'vitest'
import { allSubagentTypes } from '../../src/extension-tools/subagentTypes'

// Import the real extension tool list so we can detect drift if a tool is renamed.
// Adjust the import path to wherever extension-tools enumerates its tools.
import { allExtensionTools } from '../../src/extension-tools'

describe('subagentTypes — static guards', () => {
  it('every allowedTools entry exists in the extension tool registry', () => {
    const known = new Set(allExtensionTools.map((t) => t.name))
    for (const type of allSubagentTypes) {
      if (type.allowedTools === '*') continue
      for (const name of type.allowedTools) {
        expect(known, `unknown tool "${name}" in subagent type ${type.name}`).toContain(name)
      }
    }
  })

  it('every subagent name matches the kernel constraint', () => {
    for (const t of allSubagentTypes) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_-]*$/)
    }
  })
})
```

> **检查现状**:`allExtensionTools` 可能叫别的名字。先 `grep -n "export.*Tool" packages/mycli-web/src/extension-tools/*.ts | head -20` 找到聚合 entry,把 import 路径替换。

- [ ] **Step 2: 跑测试验证失败**

```bash
bun --cwd packages/mycli-web run test tests/extension-tools/subagentTypes.test.ts
```

预期:`Cannot find module`。

- [ ] **Step 3: 实现类型**

```ts
// packages/mycli-web/src/extension-tools/subagentTypes/generalPurpose.ts
import type { SubagentType } from 'agent-kernel'

export const generalPurpose: SubagentType = {
  name: 'general-purpose',
  description:
    'General-purpose agent for multi-step research, page reading, ' +
    'and synthesis tasks. Use when you need to investigate a topic ' +
    'across pages without polluting your own context.',
  systemPrompt: `You are a focused sub-agent dispatched to handle one self-contained sub-task.

Your final reply will be returned to your parent agent as the result of the Task tool. Make it concise, factual, and directly answer what was asked. Do NOT chat — output the answer.

Available tools: readPage, readSelection, querySelector, screenshot, listTabs, fetchGet, todoWrite.

You cannot dispatch further sub-agents.`,
  allowedTools: [
    'readPage',
    'readSelection',
    'querySelector',
    'screenshot',
    'listTabs',
    'fetchGet',
    'todoWrite',
  ],
  maxIterations: 15,
}
```

```ts
// packages/mycli-web/src/extension-tools/subagentTypes/index.ts
import { generalPurpose } from './generalPurpose'

export { generalPurpose }
export const allSubagentTypes = [generalPurpose] as const
```

- [ ] **Step 4: 改 `offscreen.ts`**

在 `bootKernelOffscreen({ ... })` 调用处加 `subagentTypes`:

```ts
import { allSubagentTypes } from '@ext-tools/subagentTypes'

bootKernelOffscreen({
  // …existing options
  subagentTypes: allSubagentTypes,
})
```

> **检查**:先 `grep -n "bootKernelOffscreen(" packages/mycli-web/src/extension/offscreen.ts` 确认实参当前形状,在适当位置插入新字段。

- [ ] **Step 5: 跑测试 + build**

```bash
bun --cwd packages/mycli-web run test tests/extension-tools/subagentTypes.test.ts
bun --cwd packages/mycli-web run test
bun --cwd packages/mycli-web run build
```

预期:全绿,build 成功。

- [ ] **Step 6: commit**

```bash
git add packages/mycli-web/src/extension-tools/subagentTypes/ \
        packages/mycli-web/src/extension/offscreen.ts \
        packages/mycli-web/tests/extension-tools/subagentTypes.test.ts
git commit -m "feat(consumer): general-purpose subagent type + offscreen wiring"
```

---

### Task 9: consumer UI — `SubagentCard` + ChatApp state map + MessageList 路由

**Files:**
- Create: `packages/mycli-web/src/extension/ui/SubagentCard.tsx`
- Modify: `packages/mycli-web/src/extension/content/ChatApp.tsx`
- Modify: `packages/mycli-web/src/extension/ui/MessageList.tsx`

- [ ] **Step 1: 检查现有 UI 结构**

```bash
grep -n "ToolCallCard\|toolCalls\b" packages/mycli-web/src/extension/ui/MessageList.tsx | head -10
grep -n "todoStore\|todos\|client.on" packages/mycli-web/src/extension/content/ChatApp.tsx | head -10
```

了解 MessageList 怎么渲 tool_call 卡片(参考 T6 #3 已有的模式)、ChatApp 怎么订阅事件(应当有 `client.on('todo/updated', ...)` 之类的)。

- [ ] **Step 2: 实现 `SubagentCard.tsx`**

```tsx
// packages/mycli-web/src/extension/ui/SubagentCard.tsx
import { useState } from 'react'

export interface SubagentCardState {
  id: string
  type: string
  description: string
  status: 'running' | 'finished' | 'failed' | 'aborted'
  messages: Array<{ text: string; ts: number }>
  toolCalls: Map<
    string,
    { name: string; args: unknown; result?: unknown; error?: unknown; ok?: boolean }
  >
  finalText?: string
  error?: { code: string; message: string }
}

interface Props {
  state: SubagentCardState
}

const STATUS_GLYPH = {
  running: '⟳',
  finished: '✓',
  failed: '✗',
  aborted: '⊘',
} as const

export function SubagentCard({ state }: Props) {
  const [expanded, setExpanded] = useState(false)
  const glyph = STATUS_GLYPH[state.status]
  return (
    <div className="subagent-card" data-status={state.status}>
      <button
        type="button"
        className="subagent-card__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="subagent-card__glyph">{glyph}</span>
        <span className="subagent-card__type">{state.type}</span>
        <span className="subagent-card__desc">{state.description}</span>
      </button>
      {state.status === 'finished' && state.finalText && !expanded && (
        <div className="subagent-card__preview">{state.finalText.slice(0, 200)}</div>
      )}
      {state.status === 'failed' && state.error && (
        <div className="subagent-card__error">
          {state.error.code}: {state.error.message}
        </div>
      )}
      {expanded && (
        <div className="subagent-card__body">
          {state.messages.map((m, i) => (
            <div key={i} className="subagent-card__msg">{m.text}</div>
          ))}
          {Array.from(state.toolCalls.entries()).map(([callId, tc]) => (
            <div key={callId} className="subagent-card__tool">
              <code>{tc.name}</code>
              {tc.ok === false && <span className="subagent-card__tool-err"> (error)</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

> CSS 由现有 Shadow-DOM 样式表(`content/styles.css` 或类似)在 follow-up 补;v1 用 className 占位即可,先保证结构正确。如果想顺手加最小样式,在最近的样式表追加 `.subagent-card { border:1px solid #ccc; padding:4px; margin:4px 0; }`。

- [ ] **Step 3: 改 `ChatApp.tsx` — 加 state + 事件订阅**

在已有的 state 旁边追加:

```ts
import type { SubagentCardState } from '../ui/SubagentCard'

const [subagents, setSubagents] = useState<Map<string, SubagentCardState>>(new Map())
const [callIdToSubagentId, setCallIdToSubagentId] = useState<Map<string, string>>(new Map())
```

在已有的 `client.on(...)` 订阅区追加(沿用现有事件订阅风格):

```ts
useEffect(() => {
  const offStarted = client.on('subagent/started', (ev: any) => {
    setSubagents((prev) => {
      const next = new Map(prev)
      next.set(ev.subagentId, {
        id: ev.subagentId,
        type: ev.subagentType,
        description: ev.description,
        status: 'running',
        messages: [],
        toolCalls: new Map(),
      })
      return next
    })
    setCallIdToSubagentId((prev) => {
      const next = new Map(prev)
      next.set(ev.parentCallId, ev.subagentId)
      return next
    })
  })
  const offMessage = client.on('subagent/message', (ev: any) => {
    setSubagents((prev) => {
      const cur = prev.get(ev.subagentId)
      if (!cur) return prev
      const next = new Map(prev)
      next.set(ev.subagentId, {
        ...cur,
        messages: [...cur.messages, { text: ev.text, ts: ev.ts }],
      })
      return next
    })
  })
  const offToolCall = client.on('subagent/tool_call', (ev: any) => {
    setSubagents((prev) => {
      const cur = prev.get(ev.subagentId)
      if (!cur) return prev
      const next = new Map(prev)
      const calls = new Map(cur.toolCalls)
      calls.set(ev.callId, { name: ev.toolName, args: ev.args })
      next.set(ev.subagentId, { ...cur, toolCalls: calls })
      return next
    })
  })
  const offToolEnd = client.on('subagent/tool_end', (ev: any) => {
    setSubagents((prev) => {
      const cur = prev.get(ev.subagentId)
      if (!cur) return prev
      const next = new Map(prev)
      const calls = new Map(cur.toolCalls)
      const existing = calls.get(ev.callId)
      if (existing) {
        calls.set(ev.callId, { ...existing, ok: ev.ok, result: ev.content, error: ev.error })
      }
      next.set(ev.subagentId, { ...cur, toolCalls: calls })
      return next
    })
  })
  const offFinished = client.on('subagent/finished', (ev: any) => {
    setSubagents((prev) => {
      const cur = prev.get(ev.subagentId)
      if (!cur) return prev
      const next = new Map(prev)
      const status: SubagentCardState['status'] = ev.ok
        ? 'finished'
        : ev.error?.code === 'aborted'
          ? 'aborted'
          : 'failed'
      next.set(ev.subagentId, {
        ...cur,
        status,
        finalText: ev.text,
        error: ev.error,
      })
      return next
    })
  })
  return () => {
    offStarted()
    offMessage()
    offToolCall()
    offToolEnd()
    offFinished()
  }
}, [client])
```

在已有的 turn-reset 处(查找 `resetTurnState` 或类似)清空两张 map。如果没有专门函数,在用户发新消息时清:

```ts
// Inside the send-message handler, before sending:
setSubagents(new Map())
setCallIdToSubagentId(new Map())
```

> **注意**:这里 reset 行为要和 #3 TodoWrite 的 reset 保持一致(`setTodos([])`)。若 ChatApp 已经有统一的 `resetTurnState` 函数,把上面两行加进去;否则加在 send handler。

把 `subagents` 和 `callIdToSubagentId` 通过 props 传给 `<MessageList>`(下一步用)。

- [ ] **Step 4: 改 `MessageList.tsx` — Task tool call 路由到 SubagentCard**

在 MessageList(或 ToolCallCard)渲染 tool_call 卡片的位置,找到判断 toolName 的分支(或新增一段):

```tsx
import { SubagentCard, type SubagentCardState } from './SubagentCard'

// inside the tool_call render loop:
if (call.name === 'Task') {
  const subagentId = props.callIdToSubagentId.get(call.id)
  const subState = subagentId ? props.subagents.get(subagentId) : undefined
  if (subState) {
    return <SubagentCard key={call.id} state={subState} />
  }
  // Fallback while mapping is not yet established (subagent/started not received)
}
// existing ToolCallCard rendering
return <ToolCallCard key={call.id} call={call} result={result} />
```

确保 `MessageList` 的 props 类型 `{ subagents, callIdToSubagentId }` 被加进去,ChatApp 把这两个 map 通过 props 注入。

- [ ] **Step 5: 跑 build + 测试**

```bash
bun --cwd packages/mycli-web run typecheck
bun --cwd packages/mycli-web run build
bun --cwd packages/mycli-web run test
```

预期:typecheck 干净、build 成功、现有测试不退化。

- [ ] **Step 6: commit**

```bash
git add packages/mycli-web/src/extension/ui/SubagentCard.tsx \
        packages/mycli-web/src/extension/content/ChatApp.tsx \
        packages/mycli-web/src/extension/ui/MessageList.tsx
git commit -m "feat(consumer): SubagentCard UI + ChatApp subscription + Task call routing"
```

---

### Task 10: Handoff 文档 + portability 总检

**Files:**
- Create: `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-subagent-fork.md`

- [ ] **Step 1: portability 总扫**

```bash
echo "=== core/subagent must not touch chrome.*: ==="
grep -rn "chrome\." packages/agent-kernel/src/core/subagent/ && echo "FAIL" || echo "OK"

echo "=== kernel must not import mycli-web: ==="
grep -rn "from '@ext\|from '\.\./\.\./mycli\|mycli-web" packages/agent-kernel/src/ && echo "FAIL" || echo "OK"

echo "=== consumer must not import kernel internals: ==="
grep -rn "from 'agent-kernel/src" packages/mycli-web/src/ && echo "FAIL: deep import" || echo "OK"
```

三条都应该是 OK。

- [ ] **Step 2: 全套测试 + build**

```bash
bun --cwd packages/agent-kernel run test
bun --cwd packages/mycli-web run test
bun run typecheck
bun --cwd packages/mycli-web run build
```

预期:全绿。

- [ ] **Step 3: 写 handoff 文档**

创建 `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-subagent-fork.md`:

```markdown
# Sub-agent / Fork — Handoff

**Date:** 2026-05-13
**Sub-project:** #4
**Spec:** `docs/superpowers/specs/2026-05-13-subagent-fork-design.md`
**Plan:** `docs/superpowers/plans/2026-05-13-subagent-fork.md`

## 已交付

- kernel `core/subagent/`:`SubagentType` 注册形状、`Subagent` 运行器、`Task` tool 工厂
- 5 个新 `subagent/*` AgentEvent 变体(core + wire)
- `ToolExecContext` 新增 `turnId` / `callId` / `subagentId` / `emitSubagentEvent` 字段
- `bootKernelOffscreen({ subagentTypes })` 选项:非空数组时注册 Task tool
- consumer 注册 1 个 reference 类型 `general-purpose`
- UI `SubagentCard` + ChatApp 状态订阅 + MessageList Task call 路由

## 验证

- kernel 测试:N → N + ~25(待填实际数)
- consumer 测试:51 → 51 + 1+
- build:clean
- portability:core 零 chrome / 零 mycli-web 引用 ✓

## 关键设计决策回顾

- 同步阻塞 + LLM parallel-tool-calls 天然并发(不发明 kernel-side 并发层)
- 类型 consumer 驱动,kernel 零内置
- 禁递归(Task 在子 agent 视野内被 filter)
- UI 全透明(完整 subagent/* 事件流)
- 子 agent 用独立 `subagentId` 作 conversationId(TodoWrite 隔离)
- 中间消息 ephemeral,事件 schema 留 id 字段方便 consumer 自接持久化

## v1 偏差 / 已知 follow-up

- `subagent/message` 字段用 `text: string` 而非设计稿的 `content: ContentBlock[]`(对齐 `assistant/iter`,后续可扩 `content?`)
- `SubagentType.maxConcurrent` 字段位预留但未读
- 子 agent 内部不能再 spawn 子 agent
- 子 agent 中间过程不落盘
- a11y polish、SubagentCard 样式细节、ChatApp 集成测试 — 可作 follow-up

## 下一步建议

- 给 v1 跑一次手测:让主 agent 派 1 个 general-purpose 子 agent 跑一个真实查询,验证 UI 卡片实时刷新
- 评估第 2 个 type(`explore`、`code-search` 等)的实际需求
- 考虑给 SubagentType 在 settings 暴露用户级开关(默认开 / 关)
```

(在 handoff 里把"N → N + ~25"换成 step 2 实际跑出的数字。)

- [ ] **Step 4: commit**

```bash
git add packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-subagent-fork.md
git commit -m "docs: handoff for sub-agent / fork"
```

---

## 自审

**1. Spec 覆盖检查:**
- §1 目标 6 条 → T1-T9 全覆盖。
- §1 非目标 → 全部"不做",在 T4(禁递归 filter)、T5(无 timeout)、T7(`maxConcurrent` 不读)中显式体现。
- §2 架构总览 → T1-T9 路径与代码分布表一一对应。
- §3 公共 API → T1 (ToolExecContext)、T2 (SubagentType)、T4 (Subagent)、T5 (taskTool)、T7 (bootKernelOffscreen)。
- §4 事件协议 → T3 (core) + T6 (wire),5 个变体齐。
- §5 取消/失败/限制 → T4 测试覆盖 5.1/5.2/5.3/5.4,T7 不实现 maxConcurrent (5.6),5.5 无 timeout 默认就达成。
- §6 consumer 集成 → T8 (types + offscreen wiring)、T9 (UI)。
- §7 测试策略 → T1-T9 内嵌 TDD,T10 final 跑全套。

**2. Placeholder 扫描:** 已避免"TBD"/"以后再实现"。一处"implementer 自己看代码定"位于 T7 step 4 内,是对 `createAgent` 签名差异的现实让步 —— 不属于 placeholder,属于"现状依赖,实施时再判"。已在该步骤说明明确的两条 fallback 路径。

**3. 类型一致性:** `SubagentId`、`SubagentType`、`SubagentEventInput` 在 T1-T5 中名字一致。`emitSubagentEvent` 在 T1/T4/T5/T7 中签名一致。`SubagentEventInput` 在 T1 用作 forward declaration,在 T3 用 Zod 收紧完整 schema —— 这是有意为之(避免 types.ts 反向依赖 protocol.ts)。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-13-subagent-fork.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
