# Sub-agent / Fork — Design Spec

**Date:** 2026-05-13
**Sub-project:** #4 of mycli-web agent capability roadmap
**Status:** Approved, ready for plan

## 1. Goals & Non-Goals

### Goals

1. **Spawn mechanism in kernel** — Main agent can call `Task` tool to spawn an independent sub-agent that runs its own LLM chat loop with isolated context. Sub-agent's final assistant text becomes the `Task` tool result. Multiple `Task` calls in the same main-agent turn execute concurrently via the LLM's parallel-tool-calls feature; the kernel does not invent its own concurrency layer.
2. **Consumer-driven `SubagentType` registry** — Kernel exposes a registration shape `{ name, description, systemPrompt, allowedTools, maxIterations?, model?, maxConcurrent? (reserved) }`. Kernel ships **zero** built-in types. Consumer injects an array of types into `bootKernelOffscreen({ subagentTypes })`.
3. **Full UI transparency** — Sub-agent's internal messages, tool calls, and tool results are streamed to the UI via new `subagent/*` `AgentEvent` variants. Each event carries `subagentId`, and `subagent/started` additionally carries `parentTurnId` and `parentCallId` so the UI can attach the sub-agent card to the correct main-agent tool-call card.
4. **Data isolation** — Each sub-agent receives a fresh `subagentId` used as its `ToolExecContext.conversationId`, isolating TodoWrite state per sub-agent. Approval rules and settings remain shared (global).
5. **Portable** — Zero `mycli-web` assumptions. Any browser-extension consumer can call `bootKernelOffscreen` with its own subagent types and get a working `Task` tool. mycli-web ships one reference type (`general-purpose`) as the v1 example.
6. **mycli-web UI** — Expandable sub-agent card inside the Shadow-DOM chat panel. Parallel sub-agents render side-by-side.

### Non-Goals (v1)

- **Recursive spawning.** Sub-agent's tool registry has `Task` filtered out unconditionally.
- **Persistence of intermediate sub-agent messages.** Only the final `tool_result` text (which is part of the main conversation) is persisted via existing `MessageStoreAdapter`. Event schema carries `subagentId` / `parentTurnId` / `parentCallId` so consumers can subscribe and persist if they want — kernel does not.
- **Wall-clock timeout.** `fetchTimeoutMs` (per request) + `maxIterations` (per sub-agent) + manual cancel cover this.
- **Cross–SW-restart resume.** If the offscreen document is torn down mid-run, in-flight sub-agents are treated as aborted.
- **Sub-agent loading skills, sub-sub-agents, independent model providers.** Deferred.
- **`maxConcurrent` enforcement.** Field reserved in `SubagentType` for future use; v1 leaves it unread.

## 2. Architecture Overview

### 2.1 Code layout

```
packages/agent-kernel/                        ← all kernel changes
├── src/core/
│   ├── subagent/                             ← NEW
│   │   ├── SubagentType.ts                   ← type def + registry builder
│   │   ├── Subagent.ts                       ← single-run executor
│   │   ├── taskTool.ts                       ← factory: build Task tool from registry
│   │   └── index.ts
│   ├── types.ts                              ← add SubagentId, extend ToolExecContext
│   ├── protocol.ts                           ← add 5 AgentEvent variants
│   └── index.ts                              ← re-export SubagentType, SubagentId
├── src/browser/
│   ├── agentService.ts                       ← forward Subagent events → AgentEvents
│   ├── bootKernelOffscreen.ts                ← accept subagentTypes, register Task tool
│   └── rpc/protocol.ts                       ← wire variants (5)
└── tests/core/subagent/…                     ← 4–5 test files

packages/mycli-web/                           ← reference consumer
├── src/extension-tools/subagentTypes/        ← NEW
│   ├── generalPurpose.ts
│   └── index.ts
├── src/extension/offscreen.ts                ← pass subagentTypes into boot
├── src/extension/ui/
│   ├── SubagentCard.tsx                      ← NEW
│   ├── MessageList.tsx or ToolCallCard.tsx   ← route Task tool calls → SubagentCard
│   └── ChatApp.tsx                           ← subscribe subagent/* events, state map
└── tests/extension/…                         ← 1–2 integration tests
```

### 2.2 Data flow (main agent dispatches 2 Tasks in one turn)

```
Main QueryEngine
  ├─ LLM emits 2 tool_use blocks (Task, Task)
  ├─ ToolRegistry.execute("Task", …) × 2     ← already Promise.all in current code
  │   each Task call:
  │     ├─ resolve type from registry
  │     ├─ new Subagent({ id, parentTurnId, parentCallId, type, … }).run()
  │     │     ├─ filter Task out of parent's toolRegistry, intersect with allowedTools
  │     │     ├─ build child ToolExecContext (conversationId = subagentId, …)
  │     │     ├─ build child AgentSession (system = type.systemPrompt, first user = prompt)
  │     │     ├─ child AbortController, parent.signal → child.signal
  │     │     ├─ child QueryEngine.run()
  │     │     │     ├─ emit subagent/started
  │     │     │     ├─ for each LLM step: emit subagent/message / subagent/tool_call / subagent/tool_end
  │     │     │     └─ on completion: emit subagent/finished
  │     │     └─ return final assistant text → ToolResult.ok({ data: text })
  │     ↓
  │   2 ToolResults return to Main QueryEngine
  └─ Main LLM sees both tool_results and continues
```

Key: `Subagent` re-uses `QueryEngine` — no new agent loop is invented. It just builds a fresh session with filtered tools, fresh conversationId, and a child AbortSignal.

## 3. Public API

### 3.1 `SubagentType` (in `core/subagent/SubagentType.ts`)

```ts
export interface SubagentType {
  /** LLM-facing type name. Must match /^[a-z][a-z0-9_-]*$/. Used as Task input enum. */
  readonly name: string

  /** 1-2 sentence description shown in Task tool's description to help the LLM pick a type. */
  readonly description: string

  /** Sub-agent's system prompt. Fully consumer-defined. */
  readonly systemPrompt: string

  /**
   * Whitelist of tool names the sub-agent may use.
   * Task tool is *always* filtered out (recursion is forbidden).
   * '*' means "all of the parent's tools, minus Task".
   * Otherwise, intersected with what the parent has.
   */
  readonly allowedTools: '*' | readonly string[]

  /** Override default max iterations. Falls back to QueryEngine default. */
  readonly maxIterations?: number

  /** Override the model name. Shares the parent's OpenAI client (baseUrl/apiKey). */
  readonly model?: string

  /** Reserved for future use. v1 does NOT enforce this. */
  readonly maxConcurrent?: number
}

export type SubagentTypeRegistry = ReadonlyMap<string, SubagentType>

/** Throws on duplicate names or invalid name format. */
export function buildSubagentTypeRegistry(
  types: readonly SubagentType[],
): SubagentTypeRegistry
```

### 3.2 `bootKernelOffscreen` options

```ts
interface BootKernelOffscreenOptions {
  // …existing fields
  /**
   * Optional. When provided (non-empty), registers the `Task` tool driven by
   * this registry. When omitted or empty, no Task tool is registered and the
   * kernel behaves exactly as today.
   */
  subagentTypes?: readonly SubagentType[]
}
```

### 3.3 `ToolExecContext` extension (`core/types.ts`)

```ts
export type SubagentId = string & { readonly __brand: 'SubagentId' }

export interface ToolExecContext {
  // …existing
  /** Present only when the current tool call is happening inside a sub-agent. */
  readonly subagentId?: SubagentId
}
```

### 3.4 `Subagent` runner (internal — not re-exported)

```ts
export interface SubagentRunOptions {
  readonly id: SubagentId
  readonly type: SubagentType
  readonly parentTurnId: string
  readonly parentCallId: string         // the main-agent Task tool_use id
  readonly userPrompt: string
  readonly userDescription: string
  readonly parentSignal: AbortSignal
  readonly parentCtx: ToolExecContext   // settings, approval, todoStore, etc. carried forward
  readonly llm: OpenAICompatibleClient
  readonly emit: (ev: SubagentEvent) => void
}

export interface SubagentRunResult {
  readonly text: string
  readonly iterations: number
}

export class Subagent {
  constructor(private opts: SubagentRunOptions) {}
  async run(): Promise<SubagentRunResult>  // throws AbortError or SubagentFailedError
}

export class SubagentFailedError extends Error {
  readonly code: 'max_iterations_no_result' | 'llm_error' | 'subagent_failed'
  readonly cause?: unknown
}
```

### 3.5 `Task` tool factory (`core/subagent/taskTool.ts`)

```ts
export function buildTaskTool(
  registry: SubagentTypeRegistry,
  llm: OpenAICompatibleClient,
): ToolDefinition<TaskInput, string>
```

Returned tool:

- `name: 'Task'`
- `description` — dynamically composed from registry, e.g.:

  ```
  Spawns a sub-agent to handle a focused sub-task with isolated context.
  Available types:
  - general-purpose: General-purpose agent for multi-step research and synthesis.

  Use the Task tool when a sub-task is well-defined and self-contained,
  especially if you'd otherwise pollute your own context with intermediate steps.
  You cannot nest Task calls.
  ```

- `inputSchema`:

  ```ts
  z.object({
    subagent_type: z.enum([...types.map(t => t.name)]),
    description:   z.string().min(1).max(120),
    prompt:        z.string().min(1),
  })
  ```

- `execute(input, ctx)`:
  1. Generate `subagentId = uuid()`.
  2. Resolve `type = registry.get(input.subagent_type)`.
  3. `new Subagent({ id: subagentId, type, parentTurnId: ctx.turnId, parentCallId: ctx.callId, userPrompt: input.prompt, userDescription: input.description, parentSignal: ctx.signal, parentCtx: ctx, llm, emit }).run()`.
  4. On success → `makeOk(result.text)`.
  5. On `AbortError` → re-throw (QueryEngine handles).
  6. On `SubagentFailedError` → `makeError('subagent_failed', \`Subagent ${type.name} failed: ${err.message}. The sub-task was not completed.\`, /*retryable*/ false)`.

> **Pre-req from existing kernel:** `ctx.turnId` and `ctx.callId` must be present on `ToolExecContext`. If they aren't today, add them in the same task that introduces the Task tool — they're standard agent-loop identifiers and several upcoming features want them.

## 4. Event Protocol

### 4.1 Core variants (`core/protocol.ts`, added to `AgentEvent` union)

```ts
// Sub-agent started
{ type: 'subagent/started',
  subagentId: SubagentId,
  parentTurnId: string,
  parentCallId: string,       // main-agent's Task tool_use id
  subagentType: string,
  description: string,
  prompt: string,
  startedAt: number }

// One assistant message inside the sub-agent
{ type: 'subagent/message',
  subagentId: SubagentId,
  role: 'assistant',
  content: ContentBlock[],
  ts: number }

// A tool call inside the sub-agent
{ type: 'subagent/tool_call',
  subagentId: SubagentId,
  callId: string,
  toolName: string,
  args: unknown,
  ts: number }

// A tool call result inside the sub-agent
{ type: 'subagent/tool_end',
  subagentId: SubagentId,
  callId: string,
  ok: boolean,
  content?: unknown,
  error?: { code: string; message: string },
  ts: number }

// Sub-agent finished (success / failure / abort)
{ type: 'subagent/finished',
  subagentId: SubagentId,
  ok: boolean,
  text?: string,                                // present when ok: true
  error?: { code: string; message: string },    // present when ok: false
  iterations: number,
  finishedAt: number }
```

### 4.2 Wire variants (`browser/rpc/protocol.ts`)

Same five variants, each wrapped in the standard envelope (`id`, `sessionId`, `ts`) per existing wire-protocol conventions. Validated by Zod and added to the wire `AgentEvent` discriminated union.

### 4.3 Event ordering guarantees

- `subagent/started` is emitted **before** any other `subagent/*` event for a given `subagentId`.
- `subagent/finished` is emitted **exactly once** per `subagentId`.
- All other `subagent/*` events for that id appear strictly between `started` and `finished`.
- The main-agent `tool_end` for the corresponding `Task` callId is emitted **after** the matching `subagent/finished`.

### 4.4 Example timeline (2 concurrent Tasks)

```
turn/start
message              (main agent emits 2 tool_use blocks)
tool_call            (Task, callId=cA)
tool_call            (Task, callId=cB)
subagent/started     (id=A, parentCallId=cA)
subagent/started     (id=B, parentCallId=cB)
subagent/message     (id=A, …)                ← interleaved
subagent/tool_call   (id=A, …)
subagent/message     (id=B, …)
subagent/tool_end    (id=A, …)
subagent/finished    (id=A, ok=true, text=…)
tool_end             (Task, callId=cA, ok=true, content=A.text)
subagent/finished    (id=B, ok=true, text=…)
tool_end             (Task, callId=cB, ok=true, content=B.text)
message              (main agent continues with both tool_results)
…
turn/end
```

## 5. Cancellation, Failure, Limits

### 5.1 Cancellation

- Each `Subagent` constructs its own `AbortController`. It listens to `parentSignal.abort` and forwards by calling `childController.abort(parentSignal.reason)`.
- When user cancels the turn (wire `cancelTurn`), main `AgentSession.signal` aborts → all in-flight sub-agents abort → their child LLM fetches and tool executions abort.
- On abort: emit `subagent/finished({ ok: false, error: { code: 'aborted', message: 'Sub-agent aborted' } })` so the UI can show a clean "cancelled" badge.

### 5.2 Per-sub-agent failure

- A failure in one sub-agent does **not** affect concurrent siblings (each has its own promise + own AbortController; the controllers are linked from parent → child, not child → child).
- Failures surface to the main LLM via `tool_result.is_error = true` with the standard message format:

  ```
  Subagent <type> failed: <reason>. The sub-task was not completed.
  ```

  The main LLM then decides whether to retry with a different prompt, use a different type, or give up and report to the user.

### 5.3 `maxIterations`

- Sub-agent uses `type.maxIterations ?? defaultMaxIterations` (the kernel-wide default already used by `QueryEngine`).
- "Reached max iterations without a final assistant text" → throws `SubagentFailedError('max_iterations_no_result')`.
- "Reached max iterations *with* assistant text" — treated as normal completion (the LLM produced an answer, even if it also wanted to keep tool-calling). Matches current `QueryEngine` semantics.

### 5.4 Tool errors inside a sub-agent

- A `ToolResult.error` from a tool inside the sub-agent is **not** a sub-agent failure. It flows back to the sub-agent's LLM as `tool_result.is_error = true` (same path as the main agent), and the sub-LLM decides what to do.
- Only if errors prevent the sub-LLM from ever producing a final text and `maxIterations` is hit does the sub-agent itself fail.

### 5.5 No wall-clock timeout

- Per-request `fetchTimeoutMs` (existing) + `maxIterations` + manual cancel cover all needs. No new global timeout.

### 5.6 Concurrency

- v1: kernel enforces no concurrency limit. `Promise.all` over the main LLM's parallel `Task` tool_use blocks is the only mechanism, and the LLM rarely emits more than 4 in a single turn.
- `SubagentType.maxConcurrent` is reserved in the type definition for future use but **unread** in v1. Documented as such with a `// reserved for future use` comment.

## 6. Consumer Integration (mycli-web)

### 6.1 Reference type — `general-purpose`

`packages/mycli-web/src/extension-tools/subagentTypes/generalPurpose.ts`:

```ts
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
    'readPage', 'readSelection', 'querySelector',
    'screenshot', 'listTabs', 'fetchGet', 'todoWrite',
  ],
  maxIterations: 15,
}
```

`packages/mycli-web/src/extension-tools/subagentTypes/index.ts`:

```ts
export { generalPurpose } from './generalPurpose'
import { generalPurpose } from './generalPurpose'
export const allSubagentTypes = [generalPurpose] as const
```

### 6.2 Offscreen wiring

`packages/mycli-web/src/extension/offscreen.ts`:

```ts
import { allSubagentTypes } from '@ext-tools/subagentTypes'

bootKernelOffscreen({
  // …existing options
  subagentTypes: allSubagentTypes,
})
```

### 6.3 UI: `SubagentCard.tsx`

New component, rendered inside the main-agent message list whenever a main-agent `tool_call` has `toolName === 'Task'`. The card subscribes to the matching `subagentId` (resolved via `parentCallId → subagentId` mapping built from `subagent/started` events) and renders:

- Collapsed: type badge, short `description`, status (running / done / failed / aborted), final text preview when done.
- Expanded: full timeline of sub-agent messages and tool calls (re-using the same message/tool-call presentational components as the main chat).

### 6.4 ChatApp state

```ts
interface SubagentState {
  id: string
  type: string
  description: string
  parentCallId: string
  status: 'running' | 'finished' | 'failed' | 'aborted'
  messages: ContentBlock[][]
  toolCalls: Map<string, { name: string; args: unknown; result?: unknown; error?: unknown }>
  finalText?: string
  error?: { code: string; message: string }
}

const [subagents, setSubagents] = useState<Map<string, SubagentState>>(new Map())
const [callIdToSubagentId, setCallIdToSubagentId] = useState<Map<string, string>>(new Map())
```

Event handling:

| Event | Action |
|---|---|
| `subagent/started` | Insert into `subagents` map; record `callIdToSubagentId[parentCallId] = subagentId` |
| `subagent/message` | Append `content` to `messages[]` |
| `subagent/tool_call` | Set `toolCalls[callId] = { name, args }` |
| `subagent/tool_end` | Update `toolCalls[callId]` with `result` or `error` |
| `subagent/finished` | Set `status`, `finalText` or `error`, retain entry for history |
| `chat/turn_reset` (existing) | Clear both maps (matches `resetTurnState` pattern from #3) |

### 6.5 Rendering Task tool-call cards

In `MessageList.tsx` (or `ToolCallCard.tsx`): when iterating tool-call entries, if `toolName === 'Task'`, look up `subagentId = callIdToSubagentId.get(callId)`; if present, render `<SubagentCard state={subagents.get(subagentId)} />`. Otherwise, render the generic `ToolCallCard` (early-in-turn fallback before `subagent/started` arrives).

## 7. Testing Strategy

### 7.1 Kernel (`packages/agent-kernel/tests/core/subagent/`)

1. **`SubagentType.test.ts`** — `buildSubagentTypeRegistry`: ok path, duplicate name throws, invalid name format throws, empty array returns empty map.
2. **`taskTool.test.ts`** — Factory: description contains all type names; input schema rejects unknown `subagent_type`; empty registry handled by `bootKernelOffscreen` skipping Task tool registration (asserted in test #5).
3. **`Subagent.test.ts`** — With mocked `OpenAICompatibleClient` and in-memory tool registry:
   - Success: LLM emits one assistant text → returns it.
   - Multi-turn with tool calls → final text returned.
   - `maxIterations` exhausted without text → `SubagentFailedError('max_iterations_no_result')`.
   - LLM throws → `SubagentFailedError('llm_error')`.
   - Parent signal aborts → child aborts synchronously → re-throws `AbortError`.
   - Tool registry filter: Task tool always removed even with `allowedTools: '*'`.
   - Tool registry filter: tool not in whitelist is invisible to sub-agent.
   - Child `ToolExecContext.conversationId === subagentId`.
   - Emit order: `started` → (`message` / `tool_call` / `tool_end`)\* → `finished`, exactly once each for `started` and `finished`.
4. **`agentService.subagent.test.ts`** — End-to-end through `agentService`:
   - Scripted main-LLM that emits one `Task` tool_use → assert wire event order: `tool_call(Task)` → `subagent/started` → `subagent/message` → `subagent/finished` → `tool_end(Task, content=text)`.
   - Two concurrent `Task` calls → two `subagent/*` streams properly separated by id, no cross-contamination.
5. **`bootKernelOffscreen.subagent.test.ts`**:
   - `subagentTypes` omitted → Task tool not registered, registry does not contain `Task`.
   - `subagentTypes: []` → same as omitted.
   - `subagentTypes: [generalPurpose]` → Task tool registered, description contains `'general-purpose'`.

### 7.2 Consumer (`packages/mycli-web/tests/`)

6. **`subagentTypes.test.ts`** — Static guard: every name in `generalPurpose.allowedTools` exists in the actual extension-tools registry. Catches drift when tools are renamed.
7. **`ChatApp.subagent.test.tsx`** *(optional, push to follow-up if UI testing infra is heavy)* — Feed a scripted event stream and assert `SubagentCard` rendering + state transitions.

### 7.3 Coverage target

- New kernel lines ≥ 90% covered.
- Critical paths (spawn, cancel, fail) 100% line coverage.

### 7.4 No live-LLM tests

All tests mock `OpenAICompatibleClient`. Reuse existing `tests/setup.ts` mocks for `fake-indexeddb` and `chrome.*`. If `mockOpenAIClient(scriptedResponses)` helper does not already exist in kernel tests, add it as part of the Subagent test task.

## 8. Open Questions / Risks

| Item | Risk | Mitigation |
|---|---|---|
| `ctx.turnId` / `ctx.callId` may not yet be on `ToolExecContext` | Task tool can't emit `parentTurnId` / `parentCallId` | First implementation task adds these fields (small, kernel-only) and `agentService` populates them |
| LLM provider parallel-tool-calls semantics | If the OpenAI-compatible endpoint doesn't honor `parallel_tool_calls`, sub-agents serialize | Not a kernel concern — already a property of the LLM client. Sub-agent feature still works, just one at a time |
| Event volume from chatty sub-agents | UI / wire overhead | `subagent/*` events are the same volume as the sub-agent's own message stream — no amplification. Acceptable for v1 |
| UI `parentCallId → subagentId` race | Main-agent `tool_call` arrives before `subagent/started` | UI falls back to generic `<ToolCallCard>` until the mapping is known, then swaps to `<SubagentCard>` |

## 9. Out of Scope (Explicit Restatement)

- Recursive Task calls
- Persisting sub-agent transcripts to IndexedDB
- Wall-clock timeouts
- Cross–service-worker-restart resume
- Independent LLM providers per sub-agent (only `model` name override is supported, sharing the same client)
- Skills inside sub-agents
- UI for managing custom sub-agent types (settings page, etc.)
- `maxConcurrent` enforcement
