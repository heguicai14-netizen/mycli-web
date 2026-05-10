# Agent Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent evaluation harness defined in `docs/superpowers/specs/2026-05-10-agent-eval-spec.md` — a kernel-bundled, kernel-consumer-reusable framework for scoring agent task completion, middle-link execution, and complex task handling, with 18 first-batch tasks and CI smoke + manual full-run modes.

**Architecture:** New `packages/agent-kernel/eval/` module exported as `agent-kernel/eval` sub-path. Pure TypeScript. Consumes the kernel's existing `QueryEngine` async-iterable event stream — no new public hook needed. Ships 7 reference fake tools (driven by per-task fixtures), 12 page snapshots (offline HTML, parsed via `happy-dom`), 3 judge modules (hard / trace-shape / LLM-as-judge), 3 reporters (console / markdown / json), record/replay LLM client wrapper for offline CI, and a CLI entry that loads consumer's `eval-config.ts`.

**Spec refinement vs §4.1 / §8:** The spec calls for adding `QueryEngine.on(event, handler)`. On inspection, `QueryEngine.run()` already yields a discriminated `EngineEvent` async iterable (`assistant_message_complete` / `tool_executing` / `tool_result` / `done`). The harness will consume that directly. **Net kernel change is smaller than spec stated**: only adding optional `usage: { in, out }` to `OpenAICompatibleClient`'s `done` StreamEvent and propagating it through `QueryEngine`'s `done` event. No `.on()` API.

**Tech Stack:** TypeScript 5.5, Bun ≥1.3.5 workspace, Vitest 2, `happy-dom` (new dep) for snapshot DOM parsing, OpenAI-compatible LLM (real for `full`, replayed for `smoke`).

**Migration safety rule:** Every task ends green. After each task: `bun run typecheck` + `bun --cwd packages/agent-kernel test` + `bun --cwd packages/mycli-web test` must all pass before commit. The kernel-extraction plan used the same rule — keep it.

---

## Phase Overview

| Phase | Tasks | Deliverable |
|---|---|---|
| **P1 — Kernel prep** | T1, T2 | Token usage flows from LLM client → QueryEngine `done` |
| **P2 — Harness core** | T3, T4, T5, T6, T7 | `eval/` scaffold + types + trace consumer + scorer + runner |
| **P3 — Reporters** | T8, T9, T10 | console / json / markdown reporters |
| **P4 — Fixtures + fakes + snapshots** | T11, T12, T13, T14 | FixtureCtx, 7 fake tools, 12 snapshots |
| **P5 — Judges** | T15, T16, T17 | hard / trace-shape / llm-judge |
| **P6 — Tasks** | T18, T19, T20, T21 | 6 L1 + 8 L2 + 4 L3 + `builtinSuite` |
| **P7 — CLI / replay / CI** | T22, T23, T24, T25 | record/replay, CLI, mycli-web wiring, GitHub Action + first baseline |

**Total: 25 tasks.**

---

## Phase 1 — Kernel prep

### Task 1: Add `usage` to OpenAICompatibleClient `done` event

**Why:** Eval needs token counts for the `efficiency` score. OpenAI API emits per-request usage on the final SSE chunk when `stream_options: { include_usage: true }` is set. We add it as an optional field — endpoints that don't support it (e.g., some older OpenAI-compatible endpoints) just leave `usage` undefined.

**Files:**
- Modify: `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`
- Test: `packages/agent-kernel/tests/core/openAiClientUsage.test.ts` (create)

- [ ] **Step 1: Write failing test for usage propagation**

Create `packages/agent-kernel/tests/core/openAiClientUsage.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

function fakeFetch(sseChunks: string[]) {
  return async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of sseChunks) controller.enqueue(enc.encode(c))
        controller.close()
      },
    }),
    headers: new Headers(),
  }) as any
}

describe('OpenAICompatibleClient usage propagation', () => {
  it('surfaces usage from final SSE chunk on done event', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const origFetch = globalThis.fetch
    globalThis.fetch = fakeFetch(chunks) as any
    try {
      const client = new OpenAICompatibleClient({
        apiKey: 'x', baseUrl: 'http://x', model: 'm',
      })
      const events: any[] = []
      for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
      const done = events.find((e) => e.kind === 'done')
      expect(done).toBeDefined()
      expect(done.usage).toEqual({ in: 42, out: 7 })
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('leaves usage undefined when endpoint omits it', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const origFetch = globalThis.fetch
    globalThis.fetch = fakeFetch(chunks) as any
    try {
      const client = new OpenAICompatibleClient({
        apiKey: 'x', baseUrl: 'http://x', model: 'm',
      })
      const events: any[] = []
      for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
      const done = events.find((e) => e.kind === 'done')
      expect(done.usage).toBeUndefined()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd packages/agent-kernel test openAiClientUsage`
Expected: FAIL with `done.usage` undefined in first test.

- [ ] **Step 3: Extend `StreamEvent.done` type**

In `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`, change the `done` variant:

```ts
export type StreamEvent =
  | { kind: 'delta'; text: string }
  | {
      kind: 'toolDelta'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
    }
  | {
      kind: 'done'
      stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown'
      toolCalls?: Array<{ id: string; name: string; input: unknown }>
      usage?: { in: number; out: number }
    }
```

- [ ] **Step 4: Parse `usage` from SSE stream and pass `stream_options`**

In `streamChatInner`, near where `body` is built, add:

```ts
body.stream_options = { include_usage: true }
```

In the SSE consumption loop (where each `data: ...` chunk is JSON-parsed), add a `usage` accumulator. Find the line `let reason: ...` (the inner loop's stop-reason tracking) — add alongside it:

```ts
let usage: { in: number; out: number } | undefined
```

Where each parsed JSON chunk is processed (look for `if (json.choices)`), add a sibling check **before or after** the choices block:

```ts
if (json.usage && typeof json.usage.prompt_tokens === 'number') {
  usage = { in: json.usage.prompt_tokens, out: json.usage.completion_tokens ?? 0 }
}
```

At the final `yield { kind: 'done', stopReason: reason, toolCalls: ... }` line, add `usage`:

```ts
yield {
  kind: 'done',
  stopReason: reason,
  toolCalls: tcs.length ? tcs : undefined,
  usage,
}
```

- [ ] **Step 5: Run tests**

Run: `bun --cwd packages/agent-kernel test openAiClientUsage`
Expected: PASS (both cases).

Run: `bun --cwd packages/agent-kernel test`
Expected: ALL PASS (no regression).

- [ ] **Step 6: Typecheck + consumer test + commit**

```bash
bun run typecheck
bun --cwd packages/mycli-web test
git add packages/agent-kernel/src/core/OpenAICompatibleClient.ts packages/agent-kernel/tests/core/openAiClientUsage.test.ts
git commit -m "$(cat <<'EOF'
feat(kernel/llm): emit token usage on streamChat done event

Adds optional { in, out } to StreamEvent.done by parsing the OpenAI
usage chunk emitted when stream_options.include_usage=true. Endpoints
that don't support it leave usage undefined.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Surface `usage` upward through QueryEngine `done` event

**Why:** Eval consumes `QueryEngine.run()`. We need the per-iteration usage to bubble up so the trace consumer (T5) can sum tokens across iterations.

**Files:**
- Modify: `packages/agent-kernel/src/core/QueryEngine.ts`
- Test: `packages/agent-kernel/tests/core/queryEngineUsage.test.ts` (create)

- [ ] **Step 1: Write failing test**

Create `packages/agent-kernel/tests/core/queryEngineUsage.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { QueryEngine } from '../../src/core/QueryEngine'

function fakeClient(events: any[][]) {
  let i = 0
  return {
    async *streamChat() {
      const batch = events[i++] ?? []
      for (const ev of batch) yield ev
    },
  } as any
}

describe('QueryEngine usage event', () => {
  it('emits assistant_message_complete with cumulative usage from this iteration', async () => {
    const client = fakeClient([
      [
        { kind: 'delta', text: 'done' },
        { kind: 'done', stopReason: 'stop', usage: { in: 100, out: 25 } },
      ],
    ])
    const engine = new QueryEngine({ client, tools: [], executeTool: async () => ({ ok: true, data: '' }) })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'hi' }])) out.push(ev)
    const complete = out.find((e) => e.kind === 'assistant_message_complete')
    expect(complete.usage).toEqual({ in: 100, out: 25 })
  })

  it('passes usage=undefined through cleanly when not present', async () => {
    const client = fakeClient([
      [{ kind: 'delta', text: 'hi' }, { kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({ client, tools: [], executeTool: async () => ({ ok: true, data: '' }) })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'hi' }])) out.push(ev)
    const complete = out.find((e) => e.kind === 'assistant_message_complete')
    expect(complete.usage).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/agent-kernel test queryEngineUsage`
Expected: FAIL — `usage` is not currently on `assistant_message_complete`.

- [ ] **Step 3: Extend EngineEvent and propagate usage**

In `packages/agent-kernel/src/core/QueryEngine.ts`, change the `assistant_message_complete` variant:

```ts
export type EngineEvent =
  | { kind: 'assistant_delta'; text: string }
  | {
      kind: 'assistant_message_complete'
      text: string
      toolCalls: ToolCall[]
      usage?: { in: number; out: number }
    }
  | { kind: 'tool_executing'; call: ToolCall }
  | { kind: 'tool_result'; callId: string; content: string; isError: boolean }
  | {
      kind: 'done'
      stopReason: 'end_turn' | 'tool_use' | 'max_iterations' | 'cancel' | 'error'
      error?: { code: string; message: string }
    }
```

In the inner `for await` loop where `done` is consumed, capture usage:

```ts
let usageThisIter: { in: number; out: number } | undefined
// ...
} else if (ev.kind === 'done') {
  stopReason = ev.stopReason
  toolCallsFinal = (ev.toolCalls ?? []).map(/* ... existing ... */)
  usageThisIter = ev.usage
}
```

At the `yield { kind: 'assistant_message_complete', ... }` line, add usage:

```ts
yield {
  kind: 'assistant_message_complete',
  text: assistantText,
  toolCalls: toolCallsFinal,
  usage: usageThisIter,
}
```

- [ ] **Step 4: Run test**

Run: `bun --cwd packages/agent-kernel test queryEngineUsage`
Expected: PASS (both cases).

- [ ] **Step 5: Full kernel test + typecheck + consumer test**

Run:
```bash
bun --cwd packages/agent-kernel test
bun run typecheck
bun --cwd packages/mycli-web test
```
All expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-kernel/src/core/QueryEngine.ts packages/agent-kernel/tests/core/queryEngineUsage.test.ts
git commit -m "$(cat <<'EOF'
feat(kernel/engine): propagate per-iter usage on assistant_message_complete

Surfaces { in, out } token counts up from the LLM client to consumers
so the eval harness can sum tokens across iterations for efficiency
scoring. Undefined when the LLM endpoint doesn't emit usage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Harness core

### Task 3: Workspace scaffold for `packages/agent-kernel/eval/`

**Why:** Create the directory, sub-path export, tsconfig, and barrel file. No code yet — just the slot.

**Files:**
- Create: `packages/agent-kernel/eval/package.json`
- Create: `packages/agent-kernel/eval/tsconfig.json`
- Create: `packages/agent-kernel/eval/index.ts`
- Create: `packages/agent-kernel/eval/README.md`
- Modify: `packages/agent-kernel/package.json` (add sub-path export, add `happy-dom` dep)
- Modify: `packages/agent-kernel/tsconfig.json` (include eval/ rootDir scope)

- [ ] **Step 1: Add `happy-dom` as kernel dev dep & declare sub-path export**

Edit `packages/agent-kernel/package.json`:

```json
{
  "name": "agent-kernel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Reusable agent kernel for Chrome MV3 extensions.",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./eval": "./eval/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b"
  },
  "dependencies": {
    "idb": "^8.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.270",
    "fake-indexeddb": "^6.0.0",
    "happy-dom": "^15.0.0",
    "jsdom": "^24.1.0",
    "typescript": "^5.5.3",
    "vitest": "^2.0.2"
  }
}
```

Run: `bun install`
Expected: `happy-dom` added to lockfile.

- [ ] **Step 2: Create `eval/package.json`** (lightweight — no scripts, just metadata)

```json
{
  "name": "agent-kernel-eval",
  "version": "0.0.0",
  "private": true,
  "description": "Internal: agent-kernel evaluation harness module."
}
```

- [ ] **Step 3: Create `eval/tsconfig.json`**

```json
{
  "extends": "../../mycli-web/tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../../../node_modules/.cache/tsc/agent-kernel-eval",
    "tsBuildInfoFile": "../../../node_modules/.cache/tsc/agent-kernel-eval.tsbuildinfo",
    "types": ["chrome"],
    "typeRoots": ["../node_modules/@types", "../../../node_modules/@types"]
  },
  "references": [{ "path": ".." }],
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Add reference from kernel root tsconfig**

Edit `packages/agent-kernel/tsconfig.json` — keep existing `compilerOptions`, just **change `include`** to keep eval out of the main build:

```json
{
  "extends": "../mycli-web/tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "../../node_modules/.cache/tsc/agent-kernel",
    "tsBuildInfoFile": "../../node_modules/.cache/tsc/agent-kernel.tsbuildinfo",
    "types": ["chrome"],
    "typeRoots": ["./node_modules/@types", "../../node_modules/@types"]
  },
  "include": ["src/**/*.ts"]
}
```

(Already correct — verify only.) Then edit the workspace root `tsconfig.json` to add the new ref:

Read `tsconfig.json` (at workspace root) first. If it already lists `packages/agent-kernel/tsconfig.json` and `packages/mycli-web/tsconfig.json`, add a new entry:

```json
{ "path": "packages/agent-kernel/eval" }
```

- [ ] **Step 5: Create `eval/index.ts` (empty barrel for now)**

```ts
// Public exports for the agent-kernel/eval sub-path.
// Populated incrementally over Phase 2..7.
export {}
```

- [ ] **Step 6: Create `eval/README.md`**

```markdown
# agent-kernel / eval

Internal evaluation harness for the agent kernel.

See `docs/superpowers/specs/2026-05-10-agent-eval-spec.md` for the design.

## Layout

- `core/`      — runner, scorer, trace consumer, types, reporters
- `fixtures/`  — fake tools + page snapshots
- `judges/`    — hard / trace-shape / llm-judge modules
- `tasks/`     — first batch of L1/L2/L3 tasks + builtinSuite
- `replay/`    — record/replay LLM client wrapper
- `cli/`       — `bun run eval` entry

## Usage from a kernel-consumer extension

Drop an `eval-config.ts` in your package root, then `bun run eval`. See `tasks/index.ts` for the bundled `builtinSuite`.
```

- [ ] **Step 7: Verify typecheck passes (no source files yet, just structure)**

Run: `bun run typecheck`
Expected: PASS — `agent-kernel-eval` project builds (empty), no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-kernel/package.json packages/agent-kernel/eval/ tsconfig.json
git commit -m "$(cat <<'EOF'
feat(kernel/eval): scaffold packages/agent-kernel/eval/ module

Empty sub-path export agent-kernel/eval, composite tsconfig wired into
the workspace project references, happy-dom added as kernel dev dep
(used by snapshot-driven fake tools later).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `eval/core/types.ts` — all interfaces from spec §2

**Why:** Type backbone for everything that follows. Pure types — no runtime code, so no test file needed (typecheck is the test).

**Files:**
- Create: `packages/agent-kernel/eval/core/types.ts`
- Modify: `packages/agent-kernel/eval/index.ts` (re-export types)

- [ ] **Step 1: Write `eval/core/types.ts`**

```ts
// All public interfaces for the eval harness. Mirrors spec §2.

import type { ToolDefinition } from '../../src/core/Tool'

// ── Task definition ─────────────────────────────────────────────

export type TaskLevel = 'L1' | 'L2' | 'L3'

export type FetchFixture =
  | string
  | { body: string; failOnce?: boolean; status?: number }

export interface TaskFixtures {
  snapshot?: string
  tabs?: string[]
  fetchMap?: Record<string, FetchFixture>
  skills?: Record<string, string>
}

export interface TaskBudget {
  expectedSteps: number
  expectedTokens: number
  expectedDurMs: number
  maxSteps: number
}

export interface Task {
  id: string
  level: TaskLevel
  prompt: string
  fixtures: TaskFixtures
  judge: JudgeSpec
  budget: TaskBudget
  passThreshold?: number
  tags?: string[]
}

// ── Judge spec ──────────────────────────────────────────────────

export interface JudgeSpec {
  completion?: HardAssertion[]
  trace?: TraceAssertion[]
  llm?: LlmRubric
}

export type HardAssertion =
  | { kind: 'answer-contains'; value: string | RegExp }
  | { kind: 'answer-equals'; value: string }
  | { kind: 'answer-json-path'; path: string; equals: unknown }
  | { kind: 'state-equals'; key: string; value: unknown }

export type TraceAssertion =
  | { kind: 'tool-called'; name: string; argsMatch?: Record<string, unknown> }
  | { kind: 'tool-not-called'; name: string }
  | { kind: 'tool-order'; sequence: string[]; strict?: boolean }
  | { kind: 'max-redundant-calls'; name: string; max: number }

export interface LlmRubric {
  question: string
  scale: 'pass-fail' | '0-5'
  weight?: number
}

// ── Trace ───────────────────────────────────────────────────────

export type TraceStep =
  | { kind: 'assistant-message'; text: string }
  | { kind: 'tool-call'; name: string; args: unknown; id: string }
  | {
      kind: 'tool-result'
      id: string
      ok: boolean
      data?: unknown
      error?: string
    }

export interface RunTrace {
  taskId: string
  steps: TraceStep[]
  finalAnswer: string
  tokensIn: number
  tokensOut: number
  durationMs: number
  abortReason?: 'max-iter' | 'budget-tokens' | 'timeout' | 'consumer'
}

// ── Run options + LLM config ────────────────────────────────────

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  fetchTimeoutMs?: number
}

export type ReporterId = 'console' | 'markdown' | 'json'

export interface RunOptions {
  llm: LlmConfig
  judgeLLM?: LlmConfig
  filter?: { levels?: TaskLevel[]; tags?: string[]; ids?: string[] }
  parallel?: number
  recordTo?: string
  replayFrom?: string
  reporter: ReporterId[]
  outDir: string
}

// ── Reports ─────────────────────────────────────────────────────

export interface TaskScores {
  completion: number
  traceQuality: number
  efficiency: number
  composite: number
}

export interface TaskReport {
  task: Task
  trace: RunTrace
  scores: TaskScores
  passed: boolean
  failures: string[]
}

export interface SuiteReport {
  schemaVersion: 1
  startedAt: string
  llmModel: string
  totals: { passed: number; failed: number; skipped: number }
  byLevel: Record<TaskLevel, { passed: number; failed: number; meanComposite: number }>
  byTag: Record<string, { passed: number; failed: number; meanComposite: number }>
  meanComposite: number
  meanTokens: number
  meanSteps: number
  tasks: TaskReport[]
}

// ── Suite ───────────────────────────────────────────────────────

export type Suite = Task[]

// ── FixtureCtx (built per-task by runner; consumed by fake tools) ──

export interface FixtureCtx {
  task: Task
  activeTabUrl?: string
  activeTabSnapshot?: string
  state: Map<string, unknown>
  loadSnapshot: (name: string) => string | undefined
  loadCaption: (name: string) => string | undefined
}

export type FakeToolFactory = (ctx: FixtureCtx) => ToolDefinition
```

- [ ] **Step 2: Re-export types from barrel**

Edit `packages/agent-kernel/eval/index.ts`:

```ts
// Public exports for the agent-kernel/eval sub-path.
export type * from './core/types'
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS.

(If `ToolDefinition` doesn't yet exist at `src/core/Tool.ts` exactly with that name — verify with `grep -rn "export.*ToolDefinition" packages/agent-kernel/src/`. If the export lives elsewhere, fix the import path.)

- [ ] **Step 4: Commit**

```bash
git add packages/agent-kernel/eval/
git commit -m "$(cat <<'EOF'
feat(kernel/eval): add core type definitions

Mirrors spec §2: Task / JudgeSpec / TraceStep / RunTrace / RunOptions /
TaskReport / SuiteReport / FixtureCtx. Pure types, no runtime code.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `eval/core/trace.ts` — async-iterable consumer

**Why:** Convert `QueryEngine`'s `EngineEvent` stream into a `RunTrace`. Pure function over an async iterable. TDD-friendly.

**Files:**
- Create: `packages/agent-kernel/eval/core/trace.ts`
- Test: `packages/agent-kernel/tests/eval/core/trace.test.ts` (create test directory tree)

- [ ] **Step 1: Write failing test**

Create `packages/agent-kernel/tests/eval/core/trace.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { collectTrace } from '../../../eval/core/trace'

async function* events(...evs: any[]) { for (const e of evs) yield e }

describe('collectTrace', () => {
  it('translates assistant_message_complete + tool_executing + tool_result', async () => {
    const stream = events(
      { kind: 'assistant_delta', text: 'thinking...' },
      {
        kind: 'assistant_message_complete',
        text: 'I will read the page',
        toolCalls: [{ id: 'c1', name: 'readPage', input: {} }],
        usage: { in: 100, out: 20 },
      },
      { kind: 'tool_executing', call: { id: 'c1', name: 'readPage', input: {} } },
      { kind: 'tool_result', callId: 'c1', content: 'page text', isError: false },
      {
        kind: 'assistant_message_complete',
        text: 'The page says hi.',
        toolCalls: [],
        usage: { in: 50, out: 10 },
      },
      { kind: 'done', stopReason: 'end_turn' },
    )
    const trace = await collectTrace(stream, 'L1/test', 12345)
    expect(trace.taskId).toBe('L1/test')
    expect(trace.tokensIn).toBe(150)
    expect(trace.tokensOut).toBe(30)
    expect(trace.finalAnswer).toBe('The page says hi.')
    expect(trace.steps).toEqual([
      { kind: 'assistant-message', text: 'I will read the page' },
      { kind: 'tool-call', id: 'c1', name: 'readPage', args: {} },
      { kind: 'tool-result', id: 'c1', ok: true, data: 'page text' },
      { kind: 'assistant-message', text: 'The page says hi.' },
    ])
    expect(trace.durationMs).toBeGreaterThanOrEqual(0)
    expect(trace.abortReason).toBeUndefined()
  })

  it('marks abort when stop reason is max_iterations', async () => {
    const stream = events(
      { kind: 'assistant_message_complete', text: '', toolCalls: [] },
      { kind: 'done', stopReason: 'max_iterations' },
    )
    const trace = await collectTrace(stream, 'L1/abort', 0)
    expect(trace.abortReason).toBe('max-iter')
  })

  it('parses tool_result error JSON content into error string', async () => {
    const stream = events(
      {
        kind: 'assistant_message_complete',
        text: 'try fetch',
        toolCalls: [{ id: 'c1', name: 'fetchGet', input: { url: 'x' } }],
      },
      {
        kind: 'tool_result',
        callId: 'c1',
        content: JSON.stringify({ message: 'http 500' }),
        isError: true,
      },
      { kind: 'assistant_message_complete', text: 'failed', toolCalls: [] },
      { kind: 'done', stopReason: 'end_turn' },
    )
    const trace = await collectTrace(stream, 'L2/err', 0)
    const result = trace.steps.find((s) => s.kind === 'tool-result') as any
    expect(result.ok).toBe(false)
    expect(result.error).toContain('http 500')
  })
})
```

Also create the test parent dir:

```bash
mkdir -p packages/agent-kernel/tests/eval/core
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/agent-kernel test eval/core/trace`
Expected: FAIL — `collectTrace` not exported.

- [ ] **Step 3: Implement `eval/core/trace.ts`**

```ts
import type { EngineEvent } from '../../src/core/QueryEngine'
import type { RunTrace, TraceStep } from './types'

const ABORT_MAP: Record<string, RunTrace['abortReason']> = {
  max_iterations: 'max-iter',
  cancel: 'consumer',
  error: 'consumer',
}

/**
 * Consume the QueryEngine event stream into a flat RunTrace.
 * - finalAnswer = text of the last assistant_message_complete
 * - tokens summed across iterations (undefined usage counts as 0)
 * - durationMs measured from collectTrace() invocation
 */
export async function collectTrace(
  events: AsyncIterable<EngineEvent>,
  taskId: string,
  startedAt: number = Date.now(),
): Promise<RunTrace> {
  const trace: RunTrace = {
    taskId,
    steps: [],
    finalAnswer: '',
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
  }
  for await (const ev of events) {
    if (ev.kind === 'assistant_message_complete') {
      if (ev.text) trace.steps.push({ kind: 'assistant-message', text: ev.text })
      trace.finalAnswer = ev.text
      if (ev.usage) {
        trace.tokensIn += ev.usage.in
        trace.tokensOut += ev.usage.out
      }
      for (const call of ev.toolCalls) {
        trace.steps.push({
          kind: 'tool-call',
          id: call.id,
          name: call.name,
          args: call.input,
        })
      }
    } else if (ev.kind === 'tool_result') {
      const step: TraceStep = ev.isError
        ? {
            kind: 'tool-result',
            id: ev.callId,
            ok: false,
            error: extractError(ev.content),
          }
        : {
            kind: 'tool-result',
            id: ev.callId,
            ok: true,
            data: ev.content,
          }
      trace.steps.push(step)
    } else if (ev.kind === 'done') {
      const mapped = ABORT_MAP[ev.stopReason]
      if (mapped) trace.abortReason = mapped
    }
    // assistant_delta + tool_executing are noise here
  }
  trace.durationMs = Date.now() - startedAt
  return trace
}

function extractError(content: string): string {
  try {
    const obj = JSON.parse(content)
    if (typeof obj === 'string') return obj
    if (obj && typeof obj.message === 'string') return obj.message
    return content
  } catch {
    return content
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun --cwd packages/agent-kernel test eval/core/trace`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/agent-kernel/eval/core/trace.ts packages/agent-kernel/tests/eval/core/trace.test.ts
git commit -m "$(cat <<'EOF'
feat(kernel/eval): collectTrace consumes QueryEngine event stream

Pure async-iterable → RunTrace converter. Sums per-iter usage,
captures finalAnswer from the last assistant_message_complete, maps
QueryEngine stop reasons to abortReason, and unwraps error envelopes
from tool_result content.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `eval/core/scorer.ts` — composite formula

**Why:** Implements spec §3 scoring. Pure functions over `Task` + `RunTrace` + judge results. Heavy TDD because the formulas are easy to subtly break.

**Files:**
- Create: `packages/agent-kernel/eval/core/scorer.ts`
- Test: `packages/agent-kernel/tests/eval/core/scorer.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-kernel/tests/eval/core/scorer.test.ts
import { describe, it, expect } from 'vitest'
import {
  scoreCompletion,
  scoreTraceQuality,
  scoreEfficiency,
  composite,
  passed,
  passThresholdFor,
} from '../../../eval/core/scorer'

describe('passThresholdFor', () => {
  it('L1=0.7, L2=0.6, L3=0.5', () => {
    expect(passThresholdFor('L1')).toBeCloseTo(0.7)
    expect(passThresholdFor('L2')).toBeCloseTo(0.6)
    expect(passThresholdFor('L3')).toBeCloseTo(0.5)
  })
})

describe('scoreCompletion', () => {
  it('pure hard assertions: ratio of passed', () => {
    expect(scoreCompletion({ hardPassed: 2, hardTotal: 3, llmScore: undefined, llmWeight: 0 }))
      .toBeCloseTo(2 / 3)
  })

  it('no assertions at all → 1.0', () => {
    expect(scoreCompletion({ hardPassed: 0, hardTotal: 0, llmScore: undefined, llmWeight: 0 }))
      .toBeCloseTo(1.0)
  })

  it('hard + LLM with weight=1 (default) → λ=0.30', () => {
    // hard 1.0, llm 0.0 → 1.0 * 0.7 + 0.0 * 0.3 = 0.7
    expect(scoreCompletion({ hardPassed: 2, hardTotal: 2, llmScore: 0, llmWeight: 1 }))
      .toBeCloseTo(0.7)
  })

  it('hard + LLM with weight=2 → λ=0.60', () => {
    // hard 0.5, llm 1.0 → 0.5 * 0.4 + 1.0 * 0.6 = 0.8
    expect(scoreCompletion({ hardPassed: 1, hardTotal: 2, llmScore: 1, llmWeight: 2 }))
      .toBeCloseTo(0.8)
  })

  it('clamps λ at 1.0 for huge weight', () => {
    // hard 0, llm 1.0, λ=1 → 1.0
    expect(scoreCompletion({ hardPassed: 0, hardTotal: 1, llmScore: 1, llmWeight: 100 }))
      .toBeCloseTo(1.0)
  })
})

describe('scoreTraceQuality', () => {
  it('all sub-scores 1 → 1.0', () => {
    expect(
      scoreTraceQuality({
        callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: false, recovered: false,
      }),
    ).toBeCloseTo(1.0)
  })

  it('weights: 0.6 calls + 0.2 redundancy + 0.2 recovery', () => {
    // calls 0.5, redundancy 1/2 → noRedundancy = 0.5, no failure → recovery 1
    // = 0.5*0.6 + 0.5*0.2 + 1*0.2 = 0.3 + 0.1 + 0.2 = 0.6
    expect(
      scoreTraceQuality({
        callRate: 0.5, redundancy: 1, redundancyMax: 2, hadFailure: false, recovered: false,
      }),
    ).toBeCloseTo(0.6)
  })

  it('failure not recovered → recovery 0', () => {
    // calls 1, no redundancy, hadFailure & not recovered → 0
    // = 1*0.6 + 1*0.2 + 0*0.2 = 0.8
    expect(
      scoreTraceQuality({
        callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: true, recovered: false,
      }),
    ).toBeCloseTo(0.8)
  })

  it('failure recovered → recovery 1', () => {
    expect(
      scoreTraceQuality({
        callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: true, recovered: true,
      }),
    ).toBeCloseTo(1.0)
  })
})

describe('scoreEfficiency', () => {
  it('all under budget → 1.0', () => {
    expect(
      scoreEfficiency(
        { steps: 3, tokens: 1000, durMs: 5000 },
        { expectedSteps: 5, expectedTokens: 4000, expectedDurMs: 8000, maxSteps: 8 },
      ),
    ).toBeCloseTo(1.0)
  })

  it('steps over budget linearly degrades', () => {
    // steps 10, expected 5 → stepScore = clamp(1 - (10-5)/5) = 0
    // tokens 0, dur 0 → 1, 1
    // = 0*0.5 + 1*0.4 + 1*0.1 = 0.5
    expect(
      scoreEfficiency(
        { steps: 10, tokens: 0, durMs: 0 },
        { expectedSteps: 5, expectedTokens: 4000, expectedDurMs: 8000, maxSteps: 20 },
      ),
    ).toBeCloseTo(0.5)
  })
})

describe('composite + passed', () => {
  it('composite = 0.55 completion + 0.30 trace + 0.15 efficiency', () => {
    expect(composite(1.0, 1.0, 1.0)).toBeCloseTo(1.0)
    expect(composite(0.5, 0.5, 0.5)).toBeCloseTo(0.5)
    expect(composite(1.0, 0.0, 0.0)).toBeCloseTo(0.55)
  })

  it('passed: composite ≥ threshold AND completion ≥ 0.5', () => {
    expect(passed(0.7, 0.6, 0.6)).toBe(true)        // L2 default: 0.6 threshold
    expect(passed(0.4, 0.6, 0.6)).toBe(false)       // completion < 0.5 hard cut
    expect(passed(0.8, 0.55, 0.6)).toBe(false)      // composite < threshold
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/agent-kernel test eval/core/scorer`
Expected: FAIL.

- [ ] **Step 3: Implement scorer**

```ts
// packages/agent-kernel/eval/core/scorer.ts
import type { TaskBudget, TaskLevel } from './types'

const W_COMPLETION = 0.55
const W_TRACE      = 0.30
const W_EFFICIENCY = 0.15

const W_TRACE_CALLS    = 0.6
const W_TRACE_NO_REDUN = 0.2
const W_TRACE_RECOVERY = 0.2

const W_EFF_STEPS  = 0.5
const W_EFF_TOKENS = 0.4
const W_EFF_DUR    = 0.1

const LAMBDA_LLM_BASE = 0.3

export function passThresholdFor(level: TaskLevel): number {
  return level === 'L1' ? 0.7 : level === 'L2' ? 0.6 : 0.5
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

export interface CompletionInput {
  hardPassed: number
  hardTotal: number
  llmScore: number | undefined  // 0..1
  llmWeight: number             // LlmRubric.weight, 0 if no rubric
}
export function scoreCompletion(i: CompletionInput): number {
  const hardScore = i.hardTotal === 0 ? 1.0 : i.hardPassed / i.hardTotal
  if (i.llmScore === undefined) return hardScore
  const lambda = clamp01(LAMBDA_LLM_BASE * i.llmWeight)
  return clamp01(hardScore * (1 - lambda) + i.llmScore * lambda)
}

export interface TraceQualityInput {
  callRate: number             // tool-called/not-called/order hit ratio
  redundancy: number
  redundancyMax: number        // sum of max-redundant-calls limits across asserts; default 1
  hadFailure: boolean
  recovered: boolean           // ignored if !hadFailure
}
export function scoreTraceQuality(i: TraceQualityInput): number {
  const noRedun = clamp01(1 - i.redundancy / Math.max(1, i.redundancyMax))
  const recovery = !i.hadFailure ? 1 : i.recovered ? 1 : 0
  return clamp01(
    i.callRate * W_TRACE_CALLS +
    noRedun    * W_TRACE_NO_REDUN +
    recovery   * W_TRACE_RECOVERY,
  )
}

export interface EfficiencyActuals {
  steps: number
  tokens: number
  durMs: number
}
export function scoreEfficiency(a: EfficiencyActuals, b: TaskBudget): number {
  const stepScore   = clamp01(1 - (a.steps  - b.expectedSteps)  / Math.max(1, b.expectedSteps))
  const tokenScore  = clamp01(1 - (a.tokens - b.expectedTokens) / Math.max(1, b.expectedTokens))
  const latencyScore= clamp01(1 - (a.durMs  - b.expectedDurMs)  / Math.max(1, b.expectedDurMs))
  return clamp01(
    stepScore   * W_EFF_STEPS +
    tokenScore  * W_EFF_TOKENS +
    latencyScore* W_EFF_DUR,
  )
}

export function composite(c: number, t: number, e: number): number {
  return clamp01(c * W_COMPLETION + t * W_TRACE + e * W_EFFICIENCY)
}

export function passed(comp: number, completion: number, threshold: number): boolean {
  return comp >= threshold && completion >= 0.5
}
```

- [ ] **Step 4: Run tests**

Run: `bun --cwd packages/agent-kernel test eval/core/scorer`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-kernel/eval/core/scorer.ts packages/agent-kernel/tests/eval/core/scorer.test.ts
git commit -m "$(cat <<'EOF'
feat(kernel/eval): scoring formulas (composite/trace/efficiency)

Implements spec §3.1 weights: composite = 0.55*completion + 0.30*trace +
0.15*efficiency; trace = 0.6*calls + 0.2*noRedun + 0.2*recovery;
efficiency = 0.5*steps + 0.4*tokens + 0.1*latency. λ_llm = clamp01(0.3 ×
rubric.weight). passThreshold defaults L1/L2/L3 = 0.7/0.6/0.5; passed
also requires completion ≥ 0.5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `eval/core/runner.ts` — orchestrator

**Why:** Glues everything: build tools from FixtureCtx, build QueryEngine, run, collect trace, run judges, score, accumulate `SuiteReport`. Bigger task but TDD-able with mocks.

**Files:**
- Create: `packages/agent-kernel/eval/core/runner.ts`
- Test: `packages/agent-kernel/tests/eval/core/runner.test.ts`
- Modify: `packages/agent-kernel/eval/index.ts` (export `runEval`)

> **NOTE for the implementer:** `runEval` depends on judge implementations (T15-T17), fake-tool factories (T11-T13), and replay client (T22). At this task, we only build the orchestrator with **placeholder** judge/tool sources passed via options — make `judges` and `toolFactories` injectable parameters so we can test runner in isolation.

- [ ] **Step 1: Write failing test using injected mocks**

```ts
// packages/agent-kernel/tests/eval/core/runner.test.ts
import { describe, it, expect } from 'vitest'
import { runSingleTask } from '../../../eval/core/runner'
import type { Task } from '../../../eval/core/types'

const echoTask: Task = {
  id: 'L1/echo',
  level: 'L1',
  prompt: 'say hi',
  fixtures: {},
  budget: { expectedSteps: 1, expectedTokens: 100, expectedDurMs: 1000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: 'hi' }],
  },
  tags: ['smoke'],
}

describe('runSingleTask', () => {
  it('runs a task end-to-end and returns a TaskReport', async () => {
    // Mock LLM: emit a single assistant message "hi" with no tool calls.
    const llmStub = {
      async *streamChat() {
        yield { kind: 'delta', text: 'hi' }
        yield { kind: 'done', stopReason: 'stop', usage: { in: 5, out: 1 } }
      },
    } as any

    const report = await runSingleTask({
      task: echoTask,
      llm: llmStub,
      judgeLLM: undefined,
      buildTools: () => [],
      runHardJudges: (_t, trace) => ({
        passed: trace.finalAnswer.includes('hi') ? 1 : 0,
        total: 1,
        failures: [],
      }),
      runTraceJudges: () => ({
        callRate: 1, redundancy: 0, redundancyMax: 1,
        hadFailure: false, recovered: false,
        failures: [],
      }),
      runLlmJudge: async () => undefined,
    })
    expect(report.passed).toBe(true)
    expect(report.scores.composite).toBeGreaterThan(0.5)
    expect(report.trace.finalAnswer).toBe('hi')
  })

  it('reports passed=false when answer fails the assertion', async () => {
    const llmStub = {
      async *streamChat() {
        yield { kind: 'delta', text: 'bye' }
        yield { kind: 'done', stopReason: 'stop' }
      },
    } as any
    const report = await runSingleTask({
      task: echoTask,
      llm: llmStub,
      judgeLLM: undefined,
      buildTools: () => [],
      runHardJudges: (_t, trace) => ({
        passed: trace.finalAnswer.includes('hi') ? 1 : 0,
        total: 1,
        failures: trace.finalAnswer.includes('hi') ? [] : ['answer-contains("hi"): actual="bye"'],
      }),
      runTraceJudges: () => ({
        callRate: 1, redundancy: 0, redundancyMax: 1,
        hadFailure: false, recovered: false,
        failures: [],
      }),
      runLlmJudge: async () => undefined,
    })
    expect(report.passed).toBe(false)
    expect(report.failures).toContain('answer-contains("hi"): actual="bye"')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/agent-kernel test eval/core/runner`
Expected: FAIL — `runSingleTask` not exported.

- [ ] **Step 3: Implement `eval/core/runner.ts`**

```ts
import { QueryEngine } from '../../src/core/QueryEngine'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import type { ToolDefinition } from '../../src/core/Tool'
import { collectTrace } from './trace'
import {
  scoreCompletion, scoreTraceQuality, scoreEfficiency,
  composite, passed, passThresholdFor,
} from './scorer'
import type {
  Task, TaskReport, RunTrace,
} from './types'

export interface HardJudgeResult {
  passed: number
  total: number
  failures: string[]
}
export interface TraceJudgeResult {
  callRate: number
  redundancy: number
  redundancyMax: number
  hadFailure: boolean
  recovered: boolean
  failures: string[]
}

export interface RunSingleArgs {
  task: Task
  llm: Pick<OpenAICompatibleClient, 'streamChat'>
  judgeLLM: Pick<OpenAICompatibleClient, 'streamChat'> | undefined
  buildTools: (task: Task) => ToolDefinition[]
  runHardJudges: (task: Task, trace: RunTrace) => HardJudgeResult
  runTraceJudges: (task: Task, trace: RunTrace) => TraceJudgeResult
  runLlmJudge: (
    task: Task,
    trace: RunTrace,
    judgeLLM: Pick<OpenAICompatibleClient, 'streamChat'> | undefined,
  ) => Promise<number | undefined>
}

export async function runSingleTask(args: RunSingleArgs): Promise<TaskReport> {
  const { task, llm } = args
  const tools = args.buildTools(task)
  const toolDefs = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
  const toolByName = new Map(tools.map((t) => [t.name, t]))

  const engine = new QueryEngine({
    client: llm as OpenAICompatibleClient,
    tools: toolDefs,
    toolMaxIterations: task.budget.maxSteps,
    executeTool: async (call) => {
      const def = toolByName.get(call.name)
      if (!def) return { ok: false, error: { message: `no such tool: ${call.name}` } }
      try {
        return await def.run(call.input as any)
      } catch (e: any) {
        return { ok: false, error: { message: String(e?.message ?? e) } }
      }
    },
  })

  const startedAt = Date.now()
  const trace = await collectTrace(
    engine.run([{ role: 'user', content: task.prompt }]),
    task.id,
    startedAt,
  )

  const hard = args.runHardJudges(task, trace)
  const traceJ = args.runTraceJudges(task, trace)
  const llmScore = await args.runLlmJudge(task, trace, args.judgeLLM)

  const completion = scoreCompletion({
    hardPassed: hard.passed,
    hardTotal: hard.total,
    llmScore,
    llmWeight: task.judge.llm?.weight ?? 0,
  })
  const traceQuality = scoreTraceQuality({
    callRate: traceJ.callRate,
    redundancy: traceJ.redundancy,
    redundancyMax: traceJ.redundancyMax,
    hadFailure: traceJ.hadFailure,
    recovered: traceJ.recovered,
  })
  const stepCount = trace.steps.filter((s) => s.kind === 'tool-call').length
  const efficiency = scoreEfficiency(
    { steps: stepCount, tokens: trace.tokensIn + trace.tokensOut, durMs: trace.durationMs },
    task.budget,
  )
  const comp = composite(completion, traceQuality, efficiency)
  const threshold = task.passThreshold ?? passThresholdFor(task.level)

  return {
    task,
    trace,
    scores: { completion, traceQuality, efficiency, composite: comp },
    passed: passed(comp, completion, threshold),
    failures: [...hard.failures, ...traceJ.failures],
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun --cwd packages/agent-kernel test eval/core/runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-kernel/eval/core/runner.ts packages/agent-kernel/tests/eval/core/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(kernel/eval): runSingleTask orchestrator

Builds QueryEngine from task fixtures + injected tool factory, runs the
agent against the task prompt, collects trace, dispatches injected
hard/trace/llm judges, and computes the composite TaskReport. Judges
and tool factories are injected so the runner is unit-testable in
isolation; T15-T17 / T11-T13 will provide real implementations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Reporters

### Task 8: `reporter/console.ts`

**Why:** First reporter and the one developers see most. Renders SuiteReport to a readable terminal block matching spec §6.5 console layout.

**Files:**
- Create: `packages/agent-kernel/eval/core/reporter/console.ts`
- Test: `packages/agent-kernel/tests/eval/core/reporter/console.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/agent-kernel/tests/eval/core/reporter/console.test.ts
import { describe, it, expect } from 'vitest'
import { renderConsole } from '../../../../eval/core/reporter/console'
import type { SuiteReport } from '../../../../eval/core/types'

const sample: SuiteReport = {
  schemaVersion: 1,
  startedAt: '2026-05-10T14:32:00Z',
  llmModel: 'glm-4.6',
  totals: { passed: 13, failed: 5, skipped: 0 },
  byLevel: {
    L1: { passed: 6, failed: 0, meanComposite: 0.91 },
    L2: { passed: 6, failed: 2, meanComposite: 0.71 },
    L3: { passed: 1, failed: 3, meanComposite: 0.48 },
  },
  byTag: {
    'data-analysis': { passed: 2, failed: 1, meanComposite: 0.61 },
  },
  meanComposite: 0.74,
  meanTokens: 10000,
  meanSteps: 5,
  tasks: [
    {
      task: { id: 'L2/exp-cross-validate' } as any,
      trace: { steps: [], finalAnswer: '', tokensIn: 0, tokensOut: 0, durationMs: 0 } as any,
      scores: { completion: 0.5, traceQuality: 0.5, efficiency: 0.5, composite: 0.51 },
      passed: false,
      failures: [],
    },
  ],
}

describe('renderConsole', () => {
  it('includes model and totals', () => {
    const out = renderConsole(sample)
    expect(out).toMatch(/model=glm-4\.6/)
    expect(out).toMatch(/18 tasks/)
    expect(out).toMatch(/L1\s+.+6\/6/)
    expect(out).toMatch(/L2\s+.+6\/8/)
    expect(out).toMatch(/L3\s+.+1\/4/)
    expect(out).toMatch(/TOTAL\s+13\/18/)
    expect(out).toMatch(/data-analysis\s+2\/3/)
  })
  it('lists failed task ids', () => {
    expect(renderConsole(sample)).toMatch(/L2\/exp-cross-validate.*0\.51/)
  })
})
```

- [ ] **Step 2: Verify failure**

Run: `bun --cwd packages/agent-kernel test reporter/console`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/agent-kernel/eval/core/reporter/console.ts
import type { SuiteReport, TaskLevel } from '../types'

const LEVELS: TaskLevel[] = ['L1', 'L2', 'L3']

function bar(ratio: number, width = 12): string {
  const filled = Math.round(ratio * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function pct(n: number, d: number): string {
  if (d === 0) return '  0%'
  const v = Math.round((n / d) * 100)
  return `${String(v).padStart(3)}%`
}

export function renderConsole(r: SuiteReport): string {
  const total = r.totals.passed + r.totals.failed
  const lines: string[] = []
  lines.push(`agent-kernel eval • model=${r.llmModel} • ${total} tasks`)
  lines.push('─'.repeat(45))
  for (const lvl of LEVELS) {
    const lr = r.byLevel[lvl]
    const sum = lr.passed + lr.failed
    if (sum === 0) continue
    lines.push(
      `${lvl}  ${bar(sum === 0 ? 0 : lr.passed / sum)}  ` +
      `${lr.passed}/${sum}  pass=${pct(lr.passed, sum)}  ` +
      `mean=${lr.meanComposite.toFixed(2)}`,
    )
  }
  lines.push('─'.repeat(45))
  lines.push(`TOTAL          ${r.totals.passed}/${total}  pass=${pct(r.totals.passed, total)}  mean=${r.meanComposite.toFixed(2)}`)

  const tagKeys = Object.keys(r.byTag).sort()
  if (tagKeys.length) {
    lines.push('')
    lines.push('By tag:')
    for (const k of tagKeys) {
      const t = r.byTag[k]
      const sum = t.passed + t.failed
      lines.push(`  ${k.padEnd(16)} ${t.passed}/${sum}  mean=${t.meanComposite.toFixed(2)}`)
    }
  }

  const failed = r.tasks.filter((t) => !t.passed)
  if (failed.length) {
    lines.push('')
    lines.push('Failures:')
    for (const t of failed) {
      lines.push(`  ✗ ${t.task.id.padEnd(34)} composite=${t.scores.composite.toFixed(2)}`)
    }
  }
  lines.push('')
  lines.push(
    `Tokens ~${Math.round(r.meanTokens)} avg/task   |   meanSteps=${r.meanSteps.toFixed(1)}`,
  )
  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests + commit**

```bash
bun --cwd packages/agent-kernel test reporter/console   # Expected: PASS
git add packages/agent-kernel/eval/core/reporter/console.ts packages/agent-kernel/tests/eval/core/reporter/console.test.ts
git commit -m "feat(kernel/eval): console reporter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `reporter/json.ts`

**Why:** Machine-readable. Used by `eval:check-regression` to diff vs baseline.

**Files:**
- Create: `packages/agent-kernel/eval/core/reporter/json.ts`
- Test: `packages/agent-kernel/tests/eval/core/reporter/json.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/agent-kernel/tests/eval/core/reporter/json.test.ts
import { describe, it, expect } from 'vitest'
import { renderJson } from '../../../../eval/core/reporter/json'
import type { SuiteReport } from '../../../../eval/core/types'

const sample: SuiteReport = {
  schemaVersion: 1,
  startedAt: '2026-05-10T14:32:00Z',
  llmModel: 'glm-4.6',
  totals: { passed: 1, failed: 0, skipped: 0 },
  byLevel: { L1: { passed: 1, failed: 0, meanComposite: 0.9 },
             L2: { passed: 0, failed: 0, meanComposite: 0 },
             L3: { passed: 0, failed: 0, meanComposite: 0 } },
  byTag: {},
  meanComposite: 0.9, meanTokens: 100, meanSteps: 1,
  tasks: [],
}

describe('renderJson', () => {
  it('round-trips through JSON.parse with schemaVersion=1', () => {
    const out = renderJson(sample)
    const parsed = JSON.parse(out)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.llmModel).toBe('glm-4.6')
    expect(parsed.totals.passed).toBe(1)
  })

  it('is deterministic key order (sorted)', () => {
    const a = renderJson(sample)
    const b = renderJson(sample)
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: Verify fail, implement, verify pass, commit**

```ts
// packages/agent-kernel/eval/core/reporter/json.ts
import type { SuiteReport } from '../types'

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function renderJson(r: SuiteReport): string {
  return JSON.stringify(sortKeysDeep(r), null, 2)
}
```

Run tests, expect PASS.

```bash
git add packages/agent-kernel/eval/core/reporter/json.ts packages/agent-kernel/tests/eval/core/reporter/json.test.ts
git commit -m "feat(kernel/eval): json reporter (sorted keys for diff stability)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `reporter/markdown.ts`

**Why:** Human-readable archived report. Includes per-task breakdown with trace and failures (the "what went wrong" surface).

**Files:**
- Create: `packages/agent-kernel/eval/core/reporter/markdown.ts`
- Test: `packages/agent-kernel/tests/eval/core/reporter/markdown.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/agent-kernel/tests/eval/core/reporter/markdown.test.ts
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../../../eval/core/reporter/markdown'
import type { SuiteReport } from '../../../../eval/core/types'

const sample: SuiteReport = {
  schemaVersion: 1,
  startedAt: '2026-05-10T14:32:00Z',
  llmModel: 'glm-4.6',
  totals: { passed: 1, failed: 1, skipped: 0 },
  byLevel: { L1: { passed: 1, failed: 0, meanComposite: 1 },
             L2: { passed: 0, failed: 1, meanComposite: 0.4 },
             L3: { passed: 0, failed: 0, meanComposite: 0 } },
  byTag: {},
  meanComposite: 0.7, meanTokens: 1000, meanSteps: 3,
  tasks: [
    {
      task: { id: 'L2/issue-summary', level: 'L2', prompt: 'summarize', tags: [] } as any,
      trace: {
        taskId: 'L2/issue-summary',
        steps: [
          { kind: 'assistant-message', text: 'I will read the page' },
          { kind: 'tool-call', id: 'c1', name: 'readPage', args: {} },
          { kind: 'tool-result', id: 'c1', ok: true, data: 'page text' },
        ],
        finalAnswer: 'short answer',
        tokensIn: 500, tokensOut: 50, durationMs: 3200,
      },
      scores: { completion: 0.4, traceQuality: 0.5, efficiency: 0.4, composite: 0.43 },
      passed: false,
      failures: ['answer-contains("#1234"): actual="short answer"'],
    },
  ],
}

describe('renderMarkdown', () => {
  it('starts with H1 and includes summary table', () => {
    const out = renderMarkdown(sample)
    expect(out).toMatch(/^# agent-kernel eval/m)
    expect(out).toMatch(/glm-4\.6/)
    expect(out).toMatch(/\| L1 \|/)
  })
  it('per-task section shows prompt, scores, failures, trace', () => {
    const out = renderMarkdown(sample)
    expect(out).toMatch(/## L2\/issue-summary/)
    expect(out).toMatch(/composite.*0\.43/)
    expect(out).toMatch(/answer-contains.*#1234/)
    expect(out).toMatch(/readPage/)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// packages/agent-kernel/eval/core/reporter/markdown.ts
import type { SuiteReport, TaskReport, TraceStep, TaskLevel } from '../types'

const LEVELS: TaskLevel[] = ['L1', 'L2', 'L3']

function summaryTable(r: SuiteReport): string {
  const rows = LEVELS.map((lvl) => {
    const x = r.byLevel[lvl]
    const sum = x.passed + x.failed
    return `| ${lvl} | ${x.passed}/${sum} | ${x.meanComposite.toFixed(2)} |`
  })
  return [
    `| Level | Passed | Mean composite |`,
    `|---|---|---|`,
    ...rows,
  ].join('\n')
}

function renderTrace(steps: TraceStep[]): string {
  return steps.map((s, i) => {
    const n = String(i + 1).padStart(2)
    if (s.kind === 'assistant-message') return `${n}. assistant: ${truncate(s.text, 200)}`
    if (s.kind === 'tool-call') return `${n}. tool-call  ${s.name}(${JSON.stringify(s.args)})`
    return `${n}. tool-result ok=${s.ok}` +
      (s.ok ? ` → ${truncate(String(s.data ?? ''), 120)}` : ` ✗ ${truncate(s.error ?? '', 120)}`)
  }).join('\n')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function taskSection(t: TaskReport): string {
  const status = t.passed ? '✅' : '❌'
  const lines = [
    `## ${t.task.id} ${status}`,
    '',
    `**Prompt:** ${t.task.prompt}`,
    '',
    `**Scores:** completion=${t.scores.completion.toFixed(2)} ` +
    `trace=${t.scores.traceQuality.toFixed(2)} ` +
    `efficiency=${t.scores.efficiency.toFixed(2)} ` +
    `**composite=${t.scores.composite.toFixed(2)}**`,
    '',
    `**Tokens:** in=${t.trace.tokensIn} out=${t.trace.tokensOut} ` +
    `**Duration:** ${t.trace.durationMs}ms`,
    '',
  ]
  if (t.failures.length) {
    lines.push('**Failures:**', '')
    for (const f of t.failures) lines.push(`- ✗ ${f}`)
    lines.push('')
  }
  lines.push('**Final answer:**', '', '```', truncate(t.trace.finalAnswer, 1000), '```', '')
  lines.push('**Trace:**', '', '```', renderTrace(t.trace.steps), '```', '')
  return lines.join('\n')
}

export function renderMarkdown(r: SuiteReport): string {
  const total = r.totals.passed + r.totals.failed
  return [
    `# agent-kernel eval — ${r.startedAt}`,
    '',
    `Model: \`${r.llmModel}\`   |   ${r.totals.passed}/${total} passed   |   ` +
    `mean composite: **${r.meanComposite.toFixed(2)}**`,
    '',
    summaryTable(r),
    '',
    '---',
    '',
    ...r.tasks.map(taskSection),
  ].join('\n')
}
```

- [ ] **Step 3: Run, commit**

```bash
bun --cwd packages/agent-kernel test reporter/markdown   # PASS
git add packages/agent-kernel/eval/core/reporter/markdown.ts packages/agent-kernel/tests/eval/core/reporter/markdown.test.ts
git commit -m "feat(kernel/eval): markdown reporter with per-task trace + failures

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Fixtures + fakes + snapshots

### Task 11: `FixtureCtx` + snapshot loader

**Why:** Per-task context object that fake tools read from. Includes a synchronous snapshot loader (reads from `eval/fixtures/snapshots/`) and helpers for HTML → text + `happy-dom` parsing.

**Files:**
- Create: `packages/agent-kernel/eval/fixtures/ctx.ts`
- Create: `packages/agent-kernel/eval/fixtures/htmlUtils.ts`
- Test: `packages/agent-kernel/tests/eval/fixtures/ctx.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-kernel/tests/eval/fixtures/ctx.test.ts
import { describe, it, expect } from 'vitest'
import { makeFixtureCtx } from '../../../eval/fixtures/ctx'
import { htmlToText, parseDom } from '../../../eval/fixtures/htmlUtils'
import type { Task } from '../../../eval/core/types'

const tinyTask: Task = {
  id: 't', level: 'L1', prompt: '', fixtures: {},
  judge: {}, budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
}

describe('makeFixtureCtx', () => {
  it('exposes task + state map', () => {
    const ctx = makeFixtureCtx(tinyTask, () => undefined, () => undefined)
    expect(ctx.task).toBe(tinyTask)
    expect(ctx.state).toBeInstanceOf(Map)
  })

  it('loadSnapshot returns content from injected loader', () => {
    const ctx = makeFixtureCtx(tinyTask, (n) => (n === 'a.html' ? '<p>hi</p>' : undefined), () => undefined)
    expect(ctx.loadSnapshot('a.html')).toBe('<p>hi</p>')
    expect(ctx.loadSnapshot('missing.html')).toBeUndefined()
  })
})

describe('htmlUtils', () => {
  it('htmlToText strips tags and collapses whitespace', () => {
    expect(htmlToText('<h1>Title</h1><p>Body  text.</p>')).toBe('Title Body text.')
  })
  it('parseDom returns a happy-dom Document', () => {
    const doc = parseDom('<div class="x">hello</div>')
    expect(doc.querySelector('.x')?.textContent).toBe('hello')
  })
})
```

- [ ] **Step 2: Verify fail**

Run: `bun --cwd packages/agent-kernel test eval/fixtures/ctx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/agent-kernel/eval/fixtures/htmlUtils.ts
import { Window } from 'happy-dom'

export function parseDom(html: string): Document {
  const win = new Window()
  win.document.write(html)
  return win.document as unknown as Document
}

export function htmlToText(html: string): string {
  // Strip script/style first, then tags; collapse whitespace.
  const noScript = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  const noTags   = noScript.replace(/<[^>]+>/g, ' ')
  return noTags.replace(/\s+/g, ' ').trim()
}
```

```ts
// packages/agent-kernel/eval/fixtures/ctx.ts
import type { FixtureCtx, Task } from '../core/types'

export function makeFixtureCtx(
  task: Task,
  loadSnapshot: (name: string) => string | undefined,
  loadCaption: (name: string) => string | undefined,
): FixtureCtx {
  return {
    task,
    state: new Map(),
    activeTabUrl: undefined,
    activeTabSnapshot: task.fixtures.snapshot,
    loadSnapshot,
    loadCaption,
  }
}

/** Default loader: reads from the eval/fixtures/snapshots/ folder via fs. */
export function makeFsLoader(rootDir: string): (name: string) => string | undefined {
  // Lazy require so this file stays import-safe in non-Node contexts (tests).
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  return (name) => {
    const p = path.join(rootDir, name)
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return undefined
    }
  }
}
```

- [ ] **Step 4: Run, commit**

```bash
bun --cwd packages/agent-kernel test eval/fixtures/ctx   # PASS
bun run typecheck
git add packages/agent-kernel/eval/fixtures/ packages/agent-kernel/tests/eval/fixtures/
git commit -m "feat(kernel/eval): FixtureCtx + happy-dom snapshot helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: 3 page-content fakes — `fakeReadPage` / `fakeReadSelection` / `fakeQuerySelector`

**Why:** Most tasks need at least one of these. Each is a `FakeToolFactory` returning a `ToolDefinition`.

**Files:**
- Create: `packages/agent-kernel/eval/fixtures/tools/fakeReadPage.ts`
- Create: `packages/agent-kernel/eval/fixtures/tools/fakeReadSelection.ts`
- Create: `packages/agent-kernel/eval/fixtures/tools/fakeQuerySelector.ts`
- Test: `packages/agent-kernel/tests/eval/fixtures/tools/page.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-kernel/tests/eval/fixtures/tools/page.test.ts
import { describe, it, expect } from 'vitest'
import { makeFixtureCtx } from '../../../../eval/fixtures/ctx'
import { makeFakeReadPage } from '../../../../eval/fixtures/tools/fakeReadPage'
import { makeFakeReadSelection } from '../../../../eval/fixtures/tools/fakeReadSelection'
import { makeFakeQuerySelector } from '../../../../eval/fixtures/tools/fakeQuerySelector'

const SNAP = `
<html><body>
  <h1>Hello world</h1>
  <p class="intro">Intro text.</p>
  <p>Body text.</p>
  <!-- SELECTION -->Selected paragraph here.<!-- /SELECTION -->
</body></html>
`
const task: any = {
  id: 't', level: 'L1', prompt: '', judge: {},
  fixtures: { snapshot: 'a.html' },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
}

function ctx() {
  return makeFixtureCtx(task, (n) => (n === 'a.html' ? SNAP : undefined), () => undefined)
}

describe('fakeReadPage', () => {
  it('returns text from active snapshot', async () => {
    const tool = makeFakeReadPage(ctx())
    const r = await tool.run({})
    expect(r.ok).toBe(true)
    expect((r.data as any).text).toMatch(/Hello world/)
  })
  it('returns error when no snapshot bound', async () => {
    const t2: any = { ...task, fixtures: {} }
    const c = makeFixtureCtx(t2, () => undefined, () => undefined)
    const r = await makeFakeReadPage(c).run({})
    expect(r.ok).toBe(false)
  })
})

describe('fakeReadSelection', () => {
  it('returns text between SELECTION markers', async () => {
    const r = await makeFakeReadSelection(ctx()).run({})
    expect(r.ok).toBe(true)
    expect((r.data as any).text).toBe('Selected paragraph here.')
  })
})

describe('fakeQuerySelector', () => {
  it('returns matched element textContent', async () => {
    const r = await makeFakeQuerySelector(ctx()).run({ selector: 'h1' })
    expect(r.ok).toBe(true)
    expect((r.data as any).text).toBe('Hello world')
  })
  it('returns ok:false when selector matches nothing', async () => {
    const r = await makeFakeQuerySelector(ctx()).run({ selector: '.missing' })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// packages/agent-kernel/eval/fixtures/tools/fakeReadPage.ts
import type { FakeToolFactory } from '../../core/types'
import { htmlToText } from '../htmlUtils'

export const makeFakeReadPage: FakeToolFactory = (ctx) => ({
  name: 'readPage',
  description: 'Read the active page content as plain text.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  exec: 'offscreen',
  async run(_args: unknown) {
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    if (!snap) return { ok: false, error: { message: 'no snapshot bound' } }
    const html = ctx.loadSnapshot(snap)
    if (!html) return { ok: false, error: { message: `snapshot not found: ${snap}` } }
    return { ok: true, data: { url: ctx.activeTabUrl ?? `fixture://${snap}`, text: htmlToText(html) } }
  },
})
```

```ts
// packages/agent-kernel/eval/fixtures/tools/fakeReadSelection.ts
import type { FakeToolFactory } from '../../core/types'

const RE = /<!--\s*SELECTION\s*-->([\s\S]*?)<!--\s*\/SELECTION\s*-->/

export const makeFakeReadSelection: FakeToolFactory = (ctx) => ({
  name: 'readSelection',
  description: 'Read user-selected text on the active page.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  exec: 'offscreen',
  async run(_args: unknown) {
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    const html = snap ? ctx.loadSnapshot(snap) : undefined
    if (!html) return { ok: false, error: { message: 'no snapshot bound' } }
    const m = RE.exec(html)
    if (!m) return { ok: false, error: { message: 'no <!-- SELECTION --> in snapshot' } }
    return { ok: true, data: { text: m[1].trim() } }
  },
})
```

```ts
// packages/agent-kernel/eval/fixtures/tools/fakeQuerySelector.ts
import type { FakeToolFactory } from '../../core/types'
import { parseDom } from '../htmlUtils'

export const makeFakeQuerySelector: FakeToolFactory = (ctx) => ({
  name: 'querySelector',
  description: 'Return textContent of the first element matching a CSS selector.',
  parameters: {
    type: 'object',
    properties: { selector: { type: 'string' } },
    required: ['selector'],
    additionalProperties: false,
  },
  exec: 'offscreen',
  async run(args: any) {
    const selector = String(args?.selector ?? '')
    if (!selector) return { ok: false, error: { message: 'selector required' } }
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    const html = snap ? ctx.loadSnapshot(snap) : undefined
    if (!html) return { ok: false, error: { message: 'no snapshot bound' } }
    const doc = parseDom(html)
    const el = doc.querySelector(selector)
    if (!el) return { ok: false, error: { message: `no match: ${selector}` } }
    return { ok: true, data: { text: el.textContent?.trim() ?? '' } }
  },
})
```

- [ ] **Step 3: Run, commit**

```bash
bun --cwd packages/agent-kernel test eval/fixtures/tools/page   # PASS
git add packages/agent-kernel/eval/fixtures/tools/ packages/agent-kernel/tests/eval/fixtures/tools/
git commit -m "feat(kernel/eval): fakeReadPage + fakeReadSelection + fakeQuerySelector

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: 4 remaining fakes — `fakeListTabs` / `fakeScreenshot` / `fakeFetch` / `fakeUseSkill`

**Files:**
- Create: `packages/agent-kernel/eval/fixtures/tools/fakeListTabs.ts`
- Create: `packages/agent-kernel/eval/fixtures/tools/fakeScreenshot.ts`
- Create: `packages/agent-kernel/eval/fixtures/tools/fakeFetch.ts`
- Create: `packages/agent-kernel/eval/fixtures/tools/fakeUseSkill.ts`
- Create: `packages/agent-kernel/eval/fixtures/tools/index.ts` (barrel)
- Test: `packages/agent-kernel/tests/eval/fixtures/tools/misc.test.ts`

- [ ] **Step 1: Tests**

```ts
// packages/agent-kernel/tests/eval/fixtures/tools/misc.test.ts
import { describe, it, expect } from 'vitest'
import { makeFixtureCtx } from '../../../../eval/fixtures/ctx'
import { makeFakeListTabs } from '../../../../eval/fixtures/tools/fakeListTabs'
import { makeFakeScreenshot } from '../../../../eval/fixtures/tools/fakeScreenshot'
import { makeFakeFetch } from '../../../../eval/fixtures/tools/fakeFetch'
import { makeFakeUseSkill } from '../../../../eval/fixtures/tools/fakeUseSkill'

const baseTask: any = {
  id: 't', level: 'L1', prompt: '', judge: {},
  fixtures: {},
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
}

describe('fakeListTabs', () => {
  it('returns task.fixtures.tabs', async () => {
    const t = { ...baseTask, fixtures: { tabs: ['a.html', 'b.html'] } }
    const c = makeFixtureCtx(t, () => '<title>t</title>', () => undefined)
    const r = await makeFakeListTabs(c).run({})
    expect(r.ok).toBe(true)
    expect((r.data as any).tabs).toHaveLength(2)
  })
})

describe('fakeScreenshot', () => {
  it('returns caption from companion .caption.txt', async () => {
    const t = { ...baseTask, fixtures: { snapshot: 'a.html' } }
    const c = makeFixtureCtx(t, () => '<p/>', (n) => (n === 'a.html' ? 'Screenshot of a landing page' : undefined))
    const r = await makeFakeScreenshot(c).run({})
    expect(r.ok).toBe(true)
    expect((r.data as any).caption).toBe('Screenshot of a landing page')
  })
  it('default caption when no companion file', async () => {
    const t = { ...baseTask, fixtures: { snapshot: 'a.html' } }
    const c = makeFixtureCtx(t, () => '<p/>', () => undefined)
    const r = await makeFakeScreenshot(c).run({})
    expect(r.ok).toBe(true)
  })
})

describe('fakeFetch', () => {
  it('returns body from fetchMap', async () => {
    const t = { ...baseTask, fixtures: { fetchMap: { 'http://x/y': 'hello' } } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const r = await makeFakeFetch(c).run({ url: 'http://x/y' })
    expect(r.ok).toBe(true)
    expect((r.data as any).body).toBe('hello')
  })
  it('errors on url not in fetchMap', async () => {
    const t = { ...baseTask, fixtures: { fetchMap: {} } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const r = await makeFakeFetch(c).run({ url: 'http://nope' })
    expect(r.ok).toBe(false)
  })
  it('failOnce: first call fails, subsequent succeed', async () => {
    const t = { ...baseTask, fixtures: { fetchMap: { 'http://x': { body: 'ok', failOnce: true } } } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const tool = makeFakeFetch(c)
    const r1 = await tool.run({ url: 'http://x' })
    expect(r1.ok).toBe(false)
    const r2 = await tool.run({ url: 'http://x' })
    expect(r2.ok).toBe(true)
    expect((r2.data as any).body).toBe('ok')
  })
})

describe('fakeUseSkill', () => {
  it('returns body for known skill', async () => {
    const t = { ...baseTask, fixtures: { skills: { summarizePage: 'You are a summarizer...' } } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const r = await makeFakeUseSkill(c).run({ name: 'summarizePage' })
    expect(r.ok).toBe(true)
    expect((r.data as any).body).toContain('summarizer')
  })
  it('errors for unknown skill', async () => {
    const c = makeFixtureCtx(baseTask, () => undefined, () => undefined)
    const r = await makeFakeUseSkill(c).run({ name: 'missing' })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// packages/agent-kernel/eval/fixtures/tools/fakeListTabs.ts
import type { FakeToolFactory } from '../../core/types'
import { parseDom } from '../htmlUtils'

export const makeFakeListTabs: FakeToolFactory = (ctx) => ({
  name: 'listTabs',
  description: 'List the URLs and titles of currently open tabs.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  exec: 'sw',
  async run(_args: unknown) {
    const tabs = ctx.task.fixtures.tabs ?? []
    const out = tabs.map((name) => {
      const html = ctx.loadSnapshot(name)
      const title = html ? (parseDom(html).querySelector('title')?.textContent ?? name) : name
      return { url: `fixture://${name}`, title }
    })
    return { ok: true, data: { tabs: out } }
  },
})
```

```ts
// packages/agent-kernel/eval/fixtures/tools/fakeScreenshot.ts
import type { FakeToolFactory } from '../../core/types'

export const makeFakeScreenshot: FakeToolFactory = (ctx) => ({
  name: 'screenshot',
  description: 'Capture a screenshot of the active tab and return a caption of its visible content.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  exec: 'sw',
  async run(_args: unknown) {
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    if (!snap) return { ok: false, error: { message: 'no snapshot bound' } }
    const captionFile = snap.replace(/\.html$/, '.caption.txt')
    const caption = ctx.loadCaption(captionFile) ?? `Screenshot of ${snap}`
    return { ok: true, data: { caption } }
  },
})
```

```ts
// packages/agent-kernel/eval/fixtures/tools/fakeFetch.ts
import type { FakeToolFactory } from '../../core/types'

export const makeFakeFetch: FakeToolFactory = (ctx) => {
  const seen = new Map<string, number>()
  return {
    name: 'fetchGet',
    description: 'HTTP GET a URL and return its body as text.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    exec: 'offscreen',
    async run(args: any) {
      const url = String(args?.url ?? '')
      const map = ctx.task.fixtures.fetchMap ?? {}
      const entry = map[url]
      if (entry === undefined) return { ok: false, error: { message: `no fixture for ${url}` } }
      const n = (seen.get(url) ?? 0) + 1
      seen.set(url, n)
      if (typeof entry === 'string') return { ok: true, data: { status: 200, body: entry } }
      if (entry.failOnce && n === 1) return { ok: false, error: { message: `http ${entry.status ?? 500}` } }
      return { ok: true, data: { status: entry.status ?? 200, body: entry.body } }
    },
  }
}
```

```ts
// packages/agent-kernel/eval/fixtures/tools/fakeUseSkill.ts
import type { FakeToolFactory } from '../../core/types'

export const makeFakeUseSkill: FakeToolFactory = (ctx) => ({
  name: 'useSkill',
  description: 'Load a skill by name; returns the skill body the agent should follow.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  exec: 'offscreen',
  async run(args: any) {
    const name = String(args?.name ?? '')
    const skills = ctx.task.fixtures.skills ?? {}
    const body = skills[name]
    if (body === undefined) return { ok: false, error: { message: `no such skill: ${name}` } }
    return { ok: true, data: { name, body } }
  },
})
```

```ts
// packages/agent-kernel/eval/fixtures/tools/index.ts
export { makeFakeReadPage } from './fakeReadPage'
export { makeFakeReadSelection } from './fakeReadSelection'
export { makeFakeQuerySelector } from './fakeQuerySelector'
export { makeFakeListTabs } from './fakeListTabs'
export { makeFakeScreenshot } from './fakeScreenshot'
export { makeFakeFetch } from './fakeFetch'
export { makeFakeUseSkill } from './fakeUseSkill'

import type { FakeToolFactory } from '../../core/types'
import { makeFakeReadPage } from './fakeReadPage'
import { makeFakeReadSelection } from './fakeReadSelection'
import { makeFakeQuerySelector } from './fakeQuerySelector'
import { makeFakeListTabs } from './fakeListTabs'
import { makeFakeScreenshot } from './fakeScreenshot'
import { makeFakeFetch } from './fakeFetch'
import { makeFakeUseSkill } from './fakeUseSkill'

export const allBuiltinFakes: FakeToolFactory[] = [
  makeFakeReadPage, makeFakeReadSelection, makeFakeQuerySelector,
  makeFakeListTabs, makeFakeScreenshot, makeFakeFetch, makeFakeUseSkill,
]
```

- [ ] **Step 3: Run, commit**

```bash
bun --cwd packages/agent-kernel test eval/fixtures/tools/misc   # PASS
git add packages/agent-kernel/eval/fixtures/tools/ packages/agent-kernel/tests/eval/fixtures/tools/misc.test.ts
git commit -m "feat(kernel/eval): fakeListTabs/Screenshot/Fetch/UseSkill + barrel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: 12 page snapshots

**Why:** Static HTML fixtures referenced by tasks. Each one < 100 lines, no `<script>`, with the standard provenance comment.

**Files (all under `packages/agent-kernel/eval/fixtures/snapshots/`):**

- `github-issue-1234.html`
- `selection-paragraph.html`
- `landing-page.html` (+ `landing-page.caption.txt`)
- `product-page.html`
- `blog-list.html`
- `pr-page.html`
- `article.html`
- `exp-dashboard-12345.html`
- `multi-tab-context/tab-a.html`
- `multi-tab-context/tab-b.html`
- `page-with-error.html`
- `page-clean.html`
- `INDEX.md` (manual list for now; auto-gen later)

> **NOTE for the implementer:** Below are the exact contents. Each starts with the provenance comment block per spec §7.4. Keep titles, status, comment counts, prices, etc. **exact** — they are referenced verbatim by task assertions.

- [ ] **Step 1: Create all 12 files**

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/github-issue-1234.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L1/extract-title, L2/issue-summary
  notes: GitHub-issue-shaped DOM. Title, status, 3 comments. No <script>.
-->
<html><head><title>Issue #1234: Tabs leak memory</title></head>
<body>
  <header><h1 class="issue-title">Issue #1234: Tabs leak memory</h1>
    <span class="issue-status state-open">Open</span></header>
  <article class="comments">
    <div class="comment"><b>alice</b>: Reproduced on v3.2.</div>
    <div class="comment"><b>bob</b>: I see the same on Linux.</div>
    <div class="comment"><b>carol</b>: Patch in #1240.</div>
  </article>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/selection-paragraph.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L1/extract-selection
  notes: Has SELECTION marker block.
-->
<html><body>
  <h1>Article</h1>
  <p>Lead paragraph.</p>
  <p><!-- SELECTION -->Selected sentence describing transformer attention.<!-- /SELECTION --></p>
  <p>Closing.</p>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/landing-page.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L1/screenshot-describe, L3/recover-and-replan
-->
<html><head><title>Acme — automate everything</title></head>
<body>
  <h1>Automate everything.</h1>
  <p>Acme is a workflow tool for ops teams.</p>
  <a href="/signup">Get started</a>
</body></html>
```

```
<!-- packages/agent-kernel/eval/fixtures/snapshots/landing-page.caption.txt -->
A landing page titled 'Acme — automate everything' with a hero headline and a Get started call-to-action button.
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/product-page.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L1/get-by-selector
-->
<html><head><title>Wireless Mouse — Acme Store</title></head>
<body>
  <h1 class="title">Wireless Mouse</h1>
  <span class="price">$29.99</span>
  <p class="desc">Ergonomic, 3-year battery.</p>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/blog-list.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L2/multi-step-extract
-->
<html><head><title>Engineering Blog</title></head>
<body>
  <article><h2>Post one</h2><span class="author">Alice</span></article>
  <article><h2>Post two</h2><span class="author">Bob</span></article>
  <article><h2>Post three</h2><span class="author">Carol</span></article>
  <article><h2>Post four</h2><span class="author">Dave</span></article>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/pr-page.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L3/decomposition
  notes: Lists 4 changed files, 2 of them tests.
-->
<html><head><title>PR #88: speed up parser</title></head>
<body>
  <h1>PR #88: speed up parser</h1>
  <a href="https://api.github.example/pr/88/files" id="files-link">files changed (4)</a>
  <ul class="files">
    <li>src/parser.ts</li>
    <li>src/lexer.ts</li>
    <li>tests/parser.test.ts</li>
    <li>tests/lexer.test.ts</li>
  </ul>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/article.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L3/skill-orchestration
  notes: Mentions Alice and Bob by name.
-->
<html><head><title>Talk: scaling agents</title></head>
<body>
  <h1>Scaling agents at Acme</h1>
  <p>Author: <span class="author">Eve</span></p>
  <p>Alice introduced the planner architecture; Bob added the eval harness.</p>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/exp-dashboard-12345.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L2/exp-cross-validate, L3/exp-go-no-go
  notes: gmv_per_user is intentionally inconsistent with API (13.50 vs 13.85).
-->
<html><head><title>Experiment 12345 dashboard</title></head>
<body>
  <h1>Experiment 12345 — 首页推荐改版 v3</h1>
  <table>
    <tr><th>metric</th><th>control</th><th>treatment</th></tr>
    <tr><td>ctr</td><td>8.43%</td><td>9.21%</td></tr>
    <tr><td>cvr</td><td>2.31%</td><td>2.27%</td></tr>
    <tr><td>gmv_per_user</td><td>$12.43</td><td>$13.50</td></tr>
    <tr><td>stay_sec</td><td>38.2</td><td>41.6</td></tr>
  </table>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/multi-tab-context/tab-a.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L2/cross-tab-compare, L3/skill-orchestration
-->
<html><head><title>Tab A: arguments for monorepo</title></head>
<body>
  <h1>Why a monorepo</h1>
  <p>Atomic cross-package changes; one CI; shared tooling.</p>
  <p>Mentioned by Alice.</p>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/multi-tab-context/tab-b.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L2/cross-tab-compare, L3/skill-orchestration
-->
<html><head><title>Tab B: arguments against monorepo</title></head>
<body>
  <h1>Why not a monorepo</h1>
  <p>Build times; access control; harder open-source split.</p>
  <p>Mentioned by Bob.</p>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/page-with-error.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L2/conditional-branch
-->
<html><body>
  <div class="error">Connection refused</div>
  <p>Body.</p>
</body></html>
```

```html
<!-- packages/agent-kernel/eval/fixtures/snapshots/page-clean.html -->
<!--
  source: synthetic   |   date: 2026-05-10
  used-by: L2/conditional-branch
-->
<html><head><title>Docs page</title></head>
<body>
  <h1>Quickstart</h1>
  <p>Install with bun add foo.</p>
</body></html>
```

```markdown
<!-- packages/agent-kernel/eval/fixtures/snapshots/INDEX.md -->
# Snapshots

| File | Used by |
|---|---|
| github-issue-1234.html         | L1/extract-title, L2/issue-summary |
| selection-paragraph.html       | L1/extract-selection |
| landing-page.html              | L1/screenshot-describe, L3/recover-and-replan |
| product-page.html              | L1/get-by-selector |
| blog-list.html                 | L2/multi-step-extract |
| pr-page.html                   | L3/decomposition |
| article.html                   | L3/skill-orchestration |
| exp-dashboard-12345.html       | L2/exp-cross-validate, L3/exp-go-no-go |
| multi-tab-context/tab-{a,b}.html | L2/cross-tab-compare, L3/skill-orchestration |
| page-with-error.html / page-clean.html | L2/conditional-branch |
```

- [ ] **Step 2: Smoke test that loader can read each**

```ts
// packages/agent-kernel/tests/eval/fixtures/snapshots.test.ts
import { describe, it, expect } from 'vitest'
import { makeFsLoader } from '../../../eval/fixtures/ctx'
import path from 'node:path'

const root = path.resolve(__dirname, '../../../eval/fixtures/snapshots')
const load = makeFsLoader(root)

const REQUIRED = [
  'github-issue-1234.html', 'selection-paragraph.html',
  'landing-page.html', 'product-page.html', 'blog-list.html',
  'pr-page.html', 'article.html', 'exp-dashboard-12345.html',
  'multi-tab-context/tab-a.html', 'multi-tab-context/tab-b.html',
  'page-with-error.html', 'page-clean.html',
]

describe('snapshots', () => {
  for (const name of REQUIRED) {
    it(`exists and parses: ${name}`, () => {
      const s = load(name)
      expect(s, name).toBeDefined()
      expect(s!.length).toBeGreaterThan(50)
    })
  }
})
```

- [ ] **Step 3: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval/fixtures/snapshots   # PASS
git add packages/agent-kernel/eval/fixtures/snapshots/ packages/agent-kernel/tests/eval/fixtures/snapshots.test.ts
git commit -m "feat(kernel/eval): 12 page snapshots + INDEX

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Judges

### Task 15: `judges/hard.ts` — 4 hard-assertion kinds

**Files:**
- Create: `packages/agent-kernel/eval/judges/hard.ts`
- Test: `packages/agent-kernel/tests/eval/judges/hard.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-kernel/tests/eval/judges/hard.test.ts
import { describe, it, expect } from 'vitest'
import { runHardJudges } from '../../../eval/judges/hard'
import type { Task, RunTrace } from '../../../eval/core/types'

const trace = (finalAnswer: string, state?: Map<string, unknown>): RunTrace => ({
  taskId: 't', steps: [], finalAnswer,
  tokensIn: 0, tokensOut: 0, durationMs: 0,
})

const t = (assertions: any[]): Task => ({
  id: 't', level: 'L1', prompt: '', fixtures: {}, judge: { completion: assertions },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
})

describe('runHardJudges', () => {
  it('answer-contains string', () => {
    const r = runHardJudges(
      t([{ kind: 'answer-contains', value: 'foo' }]),
      trace('foo bar'),
      new Map(),
    )
    expect(r.passed).toBe(1); expect(r.total).toBe(1); expect(r.failures).toEqual([])
  })

  it('answer-contains regex', () => {
    const r = runHardJudges(
      t([{ kind: 'answer-contains', value: /\d+/ }]),
      trace('issue 1234'),
      new Map(),
    )
    expect(r.passed).toBe(1)
  })

  it('answer-equals', () => {
    const r = runHardJudges(
      t([{ kind: 'answer-equals', value: 'exact' }]),
      trace('exact'), new Map(),
    )
    expect(r.passed).toBe(1)
    const r2 = runHardJudges(
      t([{ kind: 'answer-equals', value: 'exact' }]),
      trace('not exact'), new Map(),
    )
    expect(r2.passed).toBe(0)
    expect(r2.failures[0]).toMatch(/answer-equals/)
  })

  it('answer-json-path', () => {
    const r = runHardJudges(
      t([{ kind: 'answer-json-path', path: '$.count', equals: 4 }]),
      trace('{"count":4,"items":[]}'), new Map(),
    )
    expect(r.passed).toBe(1)
  })

  it('state-equals via FixtureCtx state map', () => {
    const state = new Map<string, unknown>([['k', 'v']])
    const r = runHardJudges(
      t([{ kind: 'state-equals', key: 'k', value: 'v' }]),
      trace(''), state,
    )
    expect(r.passed).toBe(1)
  })

  it('returns failures with actual values', () => {
    const r = runHardJudges(
      t([{ kind: 'answer-contains', value: 'foo' }]),
      trace('bar'), new Map(),
    )
    expect(r.passed).toBe(0)
    expect(r.failures[0]).toMatch(/answer-contains.*foo.*actual.*bar/)
  })

  it('reports zero asserts when none provided', () => {
    const r = runHardJudges({ ...t([]), judge: {} }, trace(''), new Map())
    expect(r.total).toBe(0); expect(r.passed).toBe(0)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// packages/agent-kernel/eval/judges/hard.ts
import type { HardAssertion, RunTrace, Task } from '../core/types'
import type { HardJudgeResult } from '../core/runner'

function jsonPath(obj: unknown, path: string): unknown {
  // Minimal `$.a.b.c` resolver. No wildcards, no arrays.
  if (!path.startsWith('$')) return undefined
  const parts = path.slice(1).split('.').filter(Boolean)
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function check(a: HardAssertion, trace: RunTrace, state: Map<string, unknown>): { ok: boolean; reason: string } {
  if (a.kind === 'answer-contains') {
    const ok = a.value instanceof RegExp ? a.value.test(trace.finalAnswer) : trace.finalAnswer.includes(a.value)
    return { ok, reason: `answer-contains(${a.value}): actual=${JSON.stringify(trace.finalAnswer.slice(0, 200))}` }
  }
  if (a.kind === 'answer-equals') {
    const ok = trace.finalAnswer === a.value
    return { ok, reason: `answer-equals(${JSON.stringify(a.value)}): actual=${JSON.stringify(trace.finalAnswer)}` }
  }
  if (a.kind === 'answer-json-path') {
    let parsed: unknown
    try { parsed = JSON.parse(trace.finalAnswer) } catch { parsed = undefined }
    const got = jsonPath(parsed, a.path)
    return {
      ok: JSON.stringify(got) === JSON.stringify(a.equals),
      reason: `answer-json-path(${a.path}=${JSON.stringify(a.equals)}): actual=${JSON.stringify(got)}`,
    }
  }
  // state-equals
  const got = state.get(a.key)
  return {
    ok: JSON.stringify(got) === JSON.stringify(a.value),
    reason: `state-equals(${a.key}=${JSON.stringify(a.value)}): actual=${JSON.stringify(got)}`,
  }
}

export function runHardJudges(task: Task, trace: RunTrace, state: Map<string, unknown>): HardJudgeResult {
  const list = task.judge.completion ?? []
  let passed = 0
  const failures: string[] = []
  for (const a of list) {
    const r = check(a, trace, state)
    if (r.ok) passed++
    else failures.push(r.reason)
  }
  return { passed, total: list.length, failures }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval/judges/hard   # PASS
git add packages/agent-kernel/eval/judges/hard.ts packages/agent-kernel/tests/eval/judges/hard.test.ts
git commit -m "feat(kernel/eval): hard judges (contains/equals/json-path/state)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: `judges/trace-shape.ts` — 4 trace assertions + recovery

**Files:**
- Create: `packages/agent-kernel/eval/judges/trace-shape.ts`
- Test: `packages/agent-kernel/tests/eval/judges/trace-shape.test.ts`

- [ ] **Step 1: Tests**

```ts
// packages/agent-kernel/tests/eval/judges/trace-shape.test.ts
import { describe, it, expect } from 'vitest'
import { runTraceJudges } from '../../../eval/judges/trace-shape'
import type { Task, RunTrace, TraceStep } from '../../../eval/core/types'

const call = (id: string, name: string, args: unknown = {}): TraceStep => ({
  kind: 'tool-call', id, name, args,
})
const result = (id: string, ok: boolean): TraceStep => ({
  kind: 'tool-result', id, ok, ...(ok ? { data: 'x' } : { error: 'fail' }),
})

const trace = (steps: TraceStep[]): RunTrace => ({
  taskId: 't', steps, finalAnswer: '', tokensIn: 0, tokensOut: 0, durationMs: 0,
})

const T = (asserts: any[]): Task => ({
  id: 't', level: 'L1', prompt: '', fixtures: {}, judge: { trace: asserts },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
})

describe('runTraceJudges', () => {
  it('tool-called passes when present', () => {
    const r = runTraceJudges(T([{ kind: 'tool-called', name: 'readPage' }]),
      trace([call('1', 'readPage'), result('1', true)]))
    expect(r.callRate).toBe(1)
    expect(r.failures).toEqual([])
  })

  it('tool-called argsMatch is partial subset', () => {
    const r = runTraceJudges(T([{ kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /12345$/ } }]),
      trace([call('1', 'fetchGet', { url: 'http://x/exp/12345', extra: 1 }), result('1', true)]))
    expect(r.callRate).toBe(1)
  })

  it('tool-not-called fails when called', () => {
    const r = runTraceJudges(T([{ kind: 'tool-not-called', name: 'screenshot' }]),
      trace([call('1', 'screenshot'), result('1', true)]))
    expect(r.callRate).toBe(0)
    expect(r.failures[0]).toMatch(/tool-not-called/)
  })

  it('tool-order non-strict: only relative order matters', () => {
    const r = runTraceJudges(T([{ kind: 'tool-order', sequence: ['readPage', 'querySelector'] }]),
      trace([call('1', 'readPage'), result('1', true), call('2', 'querySelector'), result('2', true)]))
    expect(r.callRate).toBe(1)
  })

  it('tool-order strict: exact sequence', () => {
    const r = runTraceJudges(T([{ kind: 'tool-order', sequence: ['readPage', 'querySelector'], strict: true }]),
      trace([call('1', 'readPage'), result('1', true), call('2', 'fetchGet'), result('2', true), call('3', 'querySelector'), result('3', true)]))
    expect(r.callRate).toBe(0)
  })

  it('max-redundant-calls counts duplicates by (name + args)', () => {
    const r = runTraceJudges(T([{ kind: 'max-redundant-calls', name: 'readPage', max: 1 }]),
      trace([call('1', 'readPage'), result('1', true), call('2', 'readPage'), result('2', true)]))
    // 2 identical calls; max 1 → redundancy = 1
    expect(r.redundancy).toBe(1)
    expect(r.redundancyMax).toBeGreaterThanOrEqual(1)
  })

  it('recovery: detects after-failure tool change', () => {
    const r = runTraceJudges(T([]),
      trace([call('1', 'fetchGet', { url: 'a' }), result('1', false),
             call('2', 'readPage'), result('2', true)]))
    expect(r.hadFailure).toBe(true)
    expect(r.recovered).toBe(true)
  })

  it('recovery: same call retried = not recovered', () => {
    const r = runTraceJudges(T([]),
      trace([call('1', 'fetchGet', { url: 'a' }), result('1', false),
             call('2', 'fetchGet', { url: 'a' }), result('2', false)]))
    expect(r.hadFailure).toBe(true)
    expect(r.recovered).toBe(false)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// packages/agent-kernel/eval/judges/trace-shape.ts
import type { Task, RunTrace, TraceAssertion } from '../core/types'
import type { TraceJudgeResult } from '../core/runner'

function normalizeArgs(a: unknown): string {
  if (a === null || typeof a !== 'object') return JSON.stringify(a)
  // Deep-sort object keys; ignore signal/abort fields.
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (k === 'signal' || k === 'abort') continue
        out[k] = walk((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  return JSON.stringify(walk(a))
}

function partialMatch(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object') return false
  const a = actual as Record<string, unknown>
  for (const [k, v] of Object.entries(expected)) {
    if (v instanceof RegExp) {
      if (typeof a[k] !== 'string' || !v.test(a[k] as string)) return false
    } else if (typeof v === 'object' && v !== null) {
      if (!partialMatch(a[k], v as Record<string, unknown>)) return false
    } else if (a[k] !== v) {
      return false
    }
  }
  return true
}

function checkAssertion(a: TraceAssertion, trace: RunTrace): { ok: boolean; reason: string } {
  const calls = trace.steps.filter((s) => s.kind === 'tool-call') as Array<Extract<typeof trace.steps[number], { kind: 'tool-call' }>>
  if (a.kind === 'tool-called') {
    const matches = calls.filter((c) => c.name === a.name && (!a.argsMatch || partialMatch(c.args, a.argsMatch)))
    return { ok: matches.length > 0, reason: `tool-called(${a.name}${a.argsMatch ? `, ${JSON.stringify(a.argsMatch)}` : ''}): ${matches.length} matches` }
  }
  if (a.kind === 'tool-not-called') {
    const found = calls.some((c) => c.name === a.name)
    return { ok: !found, reason: `tool-not-called(${a.name}): actual=${found ? 'called' : 'not called'}` }
  }
  if (a.kind === 'tool-order') {
    const names = calls.map((c) => c.name)
    if (a.strict) {
      const window = names.slice(0, a.sequence.length)
      const ok = window.length === a.sequence.length && window.every((n, i) => n === a.sequence[i])
      return { ok, reason: `tool-order(strict ${a.sequence.join(',')}): actual=${names.join(',')}` }
    }
    let i = 0
    for (const n of names) if (n === a.sequence[i]) i++
    const ok = i === a.sequence.length
    return { ok, reason: `tool-order(${a.sequence.join(',')}): actual=${names.join(',')}` }
  }
  // max-redundant-calls
  const buckets = new Map<string, number>()
  for (const c of calls) {
    if (c.name !== a.name) continue
    const key = `${c.name}|${normalizeArgs(c.args)}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  let redundant = 0
  for (const v of buckets.values()) if (v > 1) redundant += v - 1
  const ok = redundant <= a.max
  return { ok, reason: `max-redundant-calls(${a.name}, max=${a.max}): actual=${redundant}` }
}

export function runTraceJudges(task: Task, trace: RunTrace): TraceJudgeResult {
  const asserts = task.judge.trace ?? []
  let passed = 0
  const failures: string[] = []
  for (const a of asserts) {
    const r = checkAssertion(a, trace)
    if (r.ok) passed++
    else failures.push(r.reason)
  }
  const callRate = asserts.length === 0 ? 1 : passed / asserts.length

  // redundancy / redundancyMax aggregated across all max-redundant-calls asserts
  let redundancy = 0
  let redundancyMax = 0
  const callsAll = trace.steps.filter((s) => s.kind === 'tool-call') as Array<Extract<typeof trace.steps[number], { kind: 'tool-call' }>>
  for (const a of asserts) {
    if (a.kind !== 'max-redundant-calls') continue
    redundancyMax += a.max
    const buckets = new Map<string, number>()
    for (const c of callsAll) {
      if (c.name !== a.name) continue
      const key = `${c.name}|${normalizeArgs(c.args)}`
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
    for (const v of buckets.values()) if (v > 1) redundancy += v - 1
  }
  if (redundancyMax === 0) redundancyMax = 1  // avoid div-by-zero in scorer

  // recovery: did any tool fail? if so, did the next tool-call differ?
  let hadFailure = false
  let recovered = false
  for (let i = 0; i < trace.steps.length; i++) {
    const s = trace.steps[i]
    if (s.kind !== 'tool-result' || s.ok) continue
    hadFailure = true
    // find the corresponding tool-call (id match)
    const failedCall = callsAll.find((c) => c.id === s.id)
    if (!failedCall) continue
    // find the next tool-call after this result step
    const nextCall = trace.steps.slice(i + 1).find((x) => x.kind === 'tool-call') as
      | Extract<typeof trace.steps[number], { kind: 'tool-call' }>
      | undefined
    if (!nextCall) {
      // no further calls — partial credit (gave up gracefully); count as 0.5 → modeled as not recovered (scorer gives 0.5 in spec §3.2)
      // we encode: hadFailure=true, recovered=false here; scorer applies 0/0.5/1 mapping at composite time
      continue
    }
    const sameCall =
      nextCall.name === failedCall.name &&
      normalizeArgs(nextCall.args) === normalizeArgs(failedCall.args)
    if (!sameCall) recovered = true
  }

  return { callRate, redundancy, redundancyMax, hadFailure, recovered, failures }
}
```

> **NOTE for the implementer:** Spec §3.2 says recovery score is 0/0.5/1 but the scorer in T6 only takes a boolean `recovered`. To honor the spec, change `TraceQualityInput.recovered` from boolean to a number `recoveryScore: 0 | 0.5 | 1`. Update `scorer.ts` and its tests accordingly. **Do this small refactor as Step 3 below.**

- [ ] **Step 3: Refactor scorer to take a 3-valued recoveryScore**

In `eval/core/scorer.ts`, change the `TraceQualityInput`:

```ts
export interface TraceQualityInput {
  callRate: number
  redundancy: number
  redundancyMax: number
  hadFailure: boolean
  recoveryScore: 0 | 0.5 | 1     // ignored when !hadFailure (treated as 1)
}
export function scoreTraceQuality(i: TraceQualityInput): number {
  const noRedun = clamp01(1 - i.redundancy / Math.max(1, i.redundancyMax))
  const recovery = !i.hadFailure ? 1 : i.recoveryScore
  return clamp01(
    i.callRate * W_TRACE_CALLS +
    noRedun    * W_TRACE_NO_REDUN +
    recovery   * W_TRACE_RECOVERY,
  )
}
```

Update `scorer.test.ts` cases that used `recovered: true/false`:

```ts
// "failure not recovered → recovery 0"
{ ..., hadFailure: true, recoveryScore: 0 }
// "failure recovered → recovery 1"
{ ..., hadFailure: true, recoveryScore: 1 }
// add new case: "gave up gracefully → recovery 0.5"
expect(scoreTraceQuality({ callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: true, recoveryScore: 0.5 }))
  .toBeCloseTo(0.9)   // 1*0.6 + 1*0.2 + 0.5*0.2 = 0.9
```

Also update `TraceJudgeResult` (in `runner.ts`) `recovered: boolean` → `recoveryScore: 0 | 0.5 | 1`, and `runner.ts` mapping line `recovered: traceJ.recovered` → `recoveryScore: traceJ.recoveryScore`.

In `trace-shape.ts`, replace `recovered: boolean` with `recoveryScore: 0 | 0.5 | 1` and compute it:

```ts
let hadFailure = false
let recoveryScore: 0 | 0.5 | 1 = 1   // default if no failure
let sawFailureWithoutFollowup = false
let sawRecovery = false
let sawSameRetry = false

for (let i = 0; i < trace.steps.length; i++) {
  const s = trace.steps[i]
  if (s.kind !== 'tool-result' || s.ok) continue
  hadFailure = true
  const failedCall = callsAll.find((c) => c.id === s.id)
  if (!failedCall) continue
  const nextCall = trace.steps.slice(i + 1).find((x) => x.kind === 'tool-call') as
    | Extract<typeof trace.steps[number], { kind: 'tool-call' }> | undefined
  if (!nextCall) { sawFailureWithoutFollowup = true; continue }
  const same = nextCall.name === failedCall.name && normalizeArgs(nextCall.args) === normalizeArgs(failedCall.args)
  if (same) sawSameRetry = true
  else sawRecovery = true
}
if (hadFailure) {
  if (sawSameRetry) recoveryScore = 0
  else if (sawRecovery) recoveryScore = 1
  else if (sawFailureWithoutFollowup) recoveryScore = 0.5
  else recoveryScore = 0
}
```

Also rename test field `recovered` → `recoveryScore` in trace-shape.test.ts; assertions become `expect(r.recoveryScore).toBe(1)` etc.

- [ ] **Step 4: Run all tests + commit**

```bash
bun --cwd packages/agent-kernel test eval   # PASS (scorer + trace-shape + everything)
git add packages/agent-kernel/eval packages/agent-kernel/tests/eval
git commit -m "feat(kernel/eval): trace-shape judges + 3-valued recovery score

Spec §3.2 recovery 0/0.5/1: 0=retried same call, 1=switched, 0.5=gave
up gracefully. Refactors TraceQualityInput.recovered → recoveryScore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: `judges/llm-judge.ts` — LLM-as-judge runner

**Files:**
- Create: `packages/agent-kernel/eval/judges/llm-judge.ts`
- Test: `packages/agent-kernel/tests/eval/judges/llm-judge.test.ts`

- [ ] **Step 1: Tests with stub LLM**

```ts
// packages/agent-kernel/tests/eval/judges/llm-judge.test.ts
import { describe, it, expect } from 'vitest'
import { runLlmJudge } from '../../../eval/judges/llm-judge'
import type { Task, RunTrace } from '../../../eval/core/types'

const trace: RunTrace = {
  taskId: 't', steps: [], finalAnswer: 'OK', tokensIn: 0, tokensOut: 0, durationMs: 0,
}
const tWith = (rubric: any): Task => ({
  id: 't', level: 'L1', prompt: 'q', fixtures: {}, judge: { llm: rubric },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
})
function fakeLlm(text: string) {
  return {
    async *streamChat() {
      yield { kind: 'delta', text }
      yield { kind: 'done', stopReason: 'stop' }
    },
  } as any
}

describe('runLlmJudge', () => {
  it('returns undefined when no rubric', async () => {
    const t: Task = { ...tWith({ question: '', scale: '0-5' }), judge: {} }
    expect(await runLlmJudge(t, trace, fakeLlm('{"score":3}'))).toBeUndefined()
  })
  it('returns undefined when no judge LLM provided', async () => {
    expect(await runLlmJudge(tWith({ question: 'ok?', scale: '0-5' }), trace, undefined)).toBeUndefined()
  })
  it('parses 0-5 scale and normalizes to 0..1', async () => {
    const r = await runLlmJudge(tWith({ question: 'ok?', scale: '0-5' }), trace, fakeLlm('{"score":4,"reason":"good"}'))
    expect(r).toBeCloseTo(0.8)
  })
  it('parses pass-fail scale (score 0 or 5)', async () => {
    const r = await runLlmJudge(tWith({ question: 'ok?', scale: 'pass-fail' }), trace, fakeLlm('{"score":5,"reason":"yes"}'))
    expect(r).toBeCloseTo(1)
  })
  it('returns undefined on unparsable response', async () => {
    expect(await runLlmJudge(tWith({ question: 'ok?', scale: '0-5' }), trace, fakeLlm('not json at all'))).toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement**

```ts
// packages/agent-kernel/eval/judges/llm-judge.ts
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import type { Task, RunTrace, TraceStep } from '../core/types'

function compactTrace(steps: TraceStep[]): string {
  return steps.map((s) => {
    if (s.kind === 'assistant-message') return `assistant: ${s.text.slice(0, 200)}`
    if (s.kind === 'tool-call') return `→ ${s.name}(${JSON.stringify(s.args).slice(0, 200)})`
    return `← ${s.ok ? 'ok' : 'err'}: ${s.ok ? String(s.data ?? '').slice(0, 100) : (s.error ?? '').slice(0, 100)}`
  }).join('\n')
}

const PROMPT = (task: Task, trace: RunTrace) => `
你是 agent 评测官。下面是 agent 任务、用户提问、agent 最终答案、完整工具调用 trace。
请按 rubric 打分。只输出 JSON：{"score": <数字>, "reason": "..."}

[Rubric] ${task.judge.llm!.question}
[Scale]  ${task.judge.llm!.scale === 'pass-fail' ? 'pass-fail (score must be 0 or 5)' : '0-5'}
[Task]   ${task.prompt}
[Answer] ${trace.finalAnswer}
[Trace]
${compactTrace(trace.steps)}
`.trim()

export async function runLlmJudge(
  task: Task,
  trace: RunTrace,
  judgeLLM: Pick<OpenAICompatibleClient, 'streamChat'> | undefined,
): Promise<number | undefined> {
  const rubric = task.judge.llm
  if (!rubric || !judgeLLM) return undefined
  let text = ''
  for await (const ev of judgeLLM.streamChat({
    messages: [{ role: 'user', content: PROMPT(task, trace) }],
  })) {
    if (ev.kind === 'delta') text += ev.text
  }
  // Find the JSON object (LLMs often wrap in code fences or chatter).
  const m = text.match(/\{[^{}]*"score"[^{}]*\}/)
  if (!m) return undefined
  try {
    const obj = JSON.parse(m[0]) as { score: number }
    if (typeof obj.score !== 'number') return undefined
    return Math.max(0, Math.min(1, obj.score / 5))
  } catch {
    return undefined
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval/judges/llm-judge   # PASS
git add packages/agent-kernel/eval/judges/llm-judge.ts packages/agent-kernel/tests/eval/judges/llm-judge.test.ts
git commit -m "feat(kernel/eval): LLM-as-judge runner

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Tasks

> **Pattern for all 4 task tasks below:** create `eval/tasks/<level>/<id>.task.ts` files exporting `export const task: Task = {...}`. After each batch, append/extend `eval/tasks/index.ts` and verify all task files satisfy the `Task` schema by running a typecheck.

### Task 18: 6 L1 task files + index scaffold

**Files (all under `packages/agent-kernel/eval/tasks/L1-basic/`):**
- `extract-title.task.ts` / `extract-selection.task.ts` / `list-tabs.task.ts`
- `get-by-selector.task.ts` / `fetch-json.task.ts` / `screenshot-describe.task.ts`
- Create: `packages/agent-kernel/eval/tasks/index.ts`
- Test: `packages/agent-kernel/tests/eval/tasks/builtinSuite.test.ts`

- [ ] **Step 1: Write all 6 L1 files**

```ts
// L1-basic/extract-title.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/extract-title',
  level: 'L1',
  prompt: '这个页面的标题是什么？',
  fixtures: { snapshot: 'github-issue-1234.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /Issue\s*#?\s*1234/ }],
    trace: [{ kind: 'tool-called', name: 'readPage' }],
  },
  tags: ['basic', 'extraction'],
}
```

```ts
// L1-basic/extract-selection.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/extract-selection',
  level: 'L1',
  prompt: '总结这段我选中的文本，用一句话。',
  fixtures: { snapshot: 'selection-paragraph.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /attention|注意力|transformer/i }],
    trace: [
      { kind: 'tool-called', name: 'readSelection' },
      { kind: 'tool-not-called', name: 'readPage' },
    ],
  },
  tags: ['basic'],
}
```

```ts
// L1-basic/list-tabs.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/list-tabs',
  level: 'L1',
  prompt: '我现在打开了哪些 tab？给我标题列表。',
  fixtures: {
    tabs: [
      'multi-tab-context/tab-a.html',
      'multi-tab-context/tab-b.html',
      'article.html',
    ],
  },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: 'monorepo' },
      { kind: 'answer-contains', value: /scaling|agents/i },
    ],
    trace: [{ kind: 'tool-called', name: 'listTabs' }],
  },
  tags: ['basic', 'multi-tab'],
}
```

```ts
// L1-basic/get-by-selector.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/get-by-selector',
  level: 'L1',
  prompt: '页面上 .price 这个元素的文本是什么？',
  fixtures: { snapshot: 'product-page.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: '$29.99' }],
    trace: [{ kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.price' } }],
  },
  tags: ['basic', 'selector'],
}
```

```ts
// L1-basic/fetch-json.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/fetch-json',
  level: 'L1',
  prompt: '拿 https://api.example/items 的 JSON，告诉我第一项的 name 字段。',
  fixtures: {
    fetchMap: {
      'https://api.example/items': JSON.stringify([
        { name: 'Widget', price: 9.99 },
        { name: 'Gizmo',  price: 14.99 },
      ]),
    },
  },
  budget: { expectedSteps: 2, expectedTokens: 1500, expectedDurMs: 5000, maxSteps: 4 },
  judge: {
    completion: [{ kind: 'answer-contains', value: 'Widget' }],
    trace: [{ kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /api\.example\/items/ } }],
  },
  tags: ['basic', 'fetch'],
}
```

```ts
// L1-basic/screenshot-describe.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/screenshot-describe',
  level: 'L1',
  prompt: '帮我看下当前页面长啥样，简单描述一下。',
  fixtures: { snapshot: 'landing-page.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /landing|Acme|automate|登陆|落地/i }],
    trace: [{ kind: 'tool-called', name: 'screenshot' }],
  },
  tags: ['basic', 'visual'],
}
```

- [ ] **Step 2: Create index/scaffolding**

```ts
// packages/agent-kernel/eval/tasks/index.ts
import type { Suite } from '../core/types'

import { task as extractTitle }     from './L1-basic/extract-title.task'
import { task as extractSelection } from './L1-basic/extract-selection.task'
import { task as listTabs }         from './L1-basic/list-tabs.task'
import { task as getBySelector }    from './L1-basic/get-by-selector.task'
import { task as fetchJson }        from './L1-basic/fetch-json.task'
import { task as screenshot }       from './L1-basic/screenshot-describe.task'

export const builtinSuite: Suite = [
  extractTitle, extractSelection, listTabs,
  getBySelector, fetchJson, screenshot,
  // L2 added in T19/T20, L3 in T21
]
```

- [ ] **Step 3: Smoke test the suite shape**

```ts
// packages/agent-kernel/tests/eval/tasks/builtinSuite.test.ts
import { describe, it, expect } from 'vitest'
import { builtinSuite } from '../../../eval/tasks/index'

describe('builtinSuite', () => {
  it('every task has required fields', () => {
    for (const t of builtinSuite) {
      expect(t.id, JSON.stringify(t)).toMatch(/^L[1-3]\//)
      expect(['L1', 'L2', 'L3']).toContain(t.level)
      expect(t.prompt.length).toBeGreaterThan(0)
      expect(t.budget.maxSteps).toBeGreaterThan(0)
    }
  })
  it('task ids are unique', () => {
    const ids = new Set<string>()
    for (const t of builtinSuite) {
      expect(ids.has(t.id), `dup id: ${t.id}`).toBe(false)
      ids.add(t.id)
    }
  })
})
```

- [ ] **Step 4: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval/tasks   # PASS
git add packages/agent-kernel/eval/tasks/ packages/agent-kernel/tests/eval/tasks/
git commit -m "feat(kernel/eval): 6 L1 basic tasks + builtinSuite scaffold

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: 4 L2 chain tasks (issue-summary / cross-tab-compare / fetch-then-extract / conditional-branch)

**Files (under `packages/agent-kernel/eval/tasks/L2-chain/`):**
- `issue-summary.task.ts` / `cross-tab-compare.task.ts` / `fetch-then-extract.task.ts` / `conditional-branch.task.ts`
- Modify: `packages/agent-kernel/eval/tasks/index.ts`

- [ ] **Step 1: Write 4 task files**

```ts
// L2-chain/issue-summary.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/issue-summary',
  level: 'L2',
  prompt: '总结这个 issue：标题、状态、最近 3 条评论。',
  fixtures: { snapshot: 'github-issue-1234.html' },
  budget: { expectedSteps: 5, expectedTokens: 4000, expectedDurMs: 8000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /Issue\s*#?\s*1234/ },
      { kind: 'answer-contains', value: /open|打开/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'max-redundant-calls', name: 'readPage', max: 1 },
    ],
    llm: {
      question: '答案是否覆盖了标题、状态、最近评论 3 个要素？',
      scale: '0-5',
      weight: 1,
    },
  },
  tags: ['chain', 'extraction'],
}
```

```ts
// L2-chain/cross-tab-compare.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/cross-tab-compare',
  level: 'L2',
  prompt: '比较 tab A 和 tab B 这两篇文章关于 monorepo 的论点差异。',
  fixtures: {
    tabs: ['multi-tab-context/tab-a.html', 'multi-tab-context/tab-b.html'],
  },
  budget: { expectedSteps: 5, expectedTokens: 4500, expectedDurMs: 9000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /monorepo/i },
      { kind: 'answer-contains', value: /CI|build|atomic/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'listTabs' },
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'max-redundant-calls', name: 'readPage', max: 2 },  // 1 per tab
    ],
    llm: {
      question: '是否分别提到了 tab A 的支持论点（atomic 改动 / 共享工具）和 tab B 的反对论点（构建时间 / 拆分困难）？',
      scale: '0-5',
      weight: 1,
    },
  },
  tags: ['chain', 'multi-tab'],
}
```

```ts
// L2-chain/fetch-then-extract.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/fetch-then-extract',
  level: 'L2',
  prompt: '从 https://api.github.example/issue/1234/labels 拿 labels 列表，告诉我有几个。',
  fixtures: {
    fetchMap: {
      'https://api.github.example/issue/1234/labels': JSON.stringify([
        { name: 'bug' }, { name: 'memory' }, { name: 'p1' },
      ]),
    },
  },
  budget: { expectedSteps: 2, expectedTokens: 1500, expectedDurMs: 5000, maxSteps: 4 },
  judge: {
    completion: [{ kind: 'answer-contains', value: '3' }],
    trace: [{ kind: 'tool-called', name: 'fetchGet' }],
  },
  tags: ['chain', 'fetch'],
}
```

```ts
// L2-chain/conditional-branch.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/conditional-branch',
  level: 'L2',
  prompt:
    '如果这个页面有 .error 元素就告诉我错误内容；否则总结一下页面主要内容。',
  fixtures: { snapshot: 'page-with-error.html' },  // error-variant
  budget: { expectedSteps: 3, expectedTokens: 2500, expectedDurMs: 6000, maxSteps: 6 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /Connection refused/ }],
    trace: [
      { kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.error' } },
      // Should NOT need readPage when error is found
      { kind: 'tool-not-called', name: 'readPage' },
    ],
  },
  tags: ['chain', 'conditional'],
}
```

> **NOTE for the implementer:** This task only covers the error-variant. The clean-page variant (`page-clean.html`) is documented as a follow-up — for v1, ship the error-only branch and add the clean variant in a future PR. Keeping scope tight.

- [ ] **Step 2: Update suite index**

In `eval/tasks/index.ts`, add imports and append to `builtinSuite`:

```ts
import { task as issueSummary }     from './L2-chain/issue-summary.task'
import { task as crossTabCompare }  from './L2-chain/cross-tab-compare.task'
import { task as fetchThenExtract } from './L2-chain/fetch-then-extract.task'
import { task as conditionalBranch }from './L2-chain/conditional-branch.task'

export const builtinSuite: Suite = [
  // ... existing L1 entries
  issueSummary, crossTabCompare, fetchThenExtract, conditionalBranch,
  // remaining L2 in T20, L3 in T21
]
```

- [ ] **Step 3: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval/tasks   # PASS (uniqueness + shape)
git add packages/agent-kernel/eval/tasks/L2-chain packages/agent-kernel/eval/tasks/index.ts
git commit -m "feat(kernel/eval): 4 L2 chain tasks (issue/tabs/fetch/conditional)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: 4 more L2 tasks (multi-step-extract / fail-then-fallback / exp-treatment-readout / exp-cross-validate)

**Files (`L2-chain/`):**
- `multi-step-extract.task.ts` / `fail-then-fallback.task.ts` / `exp-treatment-readout.task.ts` / `exp-cross-validate.task.ts`

- [ ] **Step 1: Write 4 task files**

```ts
// L2-chain/multi-step-extract.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/multi-step-extract',
  level: 'L2',
  prompt: '把这个博客列表页所有作者的名字列出来。',
  fixtures: { snapshot: 'blog-list.html' },
  budget: { expectedSteps: 2, expectedTokens: 2000, expectedDurMs: 5000, maxSteps: 5 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: 'Alice' },
      { kind: 'answer-contains', value: 'Bob' },
      { kind: 'answer-contains', value: 'Carol' },
      { kind: 'answer-contains', value: 'Dave' },
    ],
    trace: [
      { kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.author' } },
      { kind: 'max-redundant-calls', name: 'querySelector', max: 1 },
    ],
  },
  tags: ['chain', 'extraction'],
}
```

```ts
// L2-chain/fail-then-fallback.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/fail-then-fallback',
  level: 'L2',
  prompt: '拿 https://broken.example/x 的内容总结一下。',
  fixtures: {
    fetchMap: {
      'https://broken.example/x': { body: '', status: 500, failOnce: false },
    },
  },
  budget: { expectedSteps: 3, expectedTokens: 2500, expectedDurMs: 6000, maxSteps: 5 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /失败|fail|无法|error|500/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet' },
      // recovery: do not retry the same URL more than once
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
  },
  tags: ['chain', 'recovery'],
}
```

```ts
// L2-chain/exp-treatment-readout.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/exp-treatment-readout',
  level: 'L2',
  prompt:
    '拿 https://exp.internal/api/exp/12345 的实验数据，告诉我 treatment 组相对 control 组哪些指标显著上涨、哪些下跌，最后给我一个是否放量的建议。',
  fixtures: {
    fetchMap: {
      'https://exp.internal/api/exp/12345': JSON.stringify({
        name: '首页推荐改版 v3',
        duration_days: 7,
        control:   { samples: 102345, ctr: 0.0843, cvr: 0.0231, gmv_per_user: 12.43, stay_sec: 38.2 },
        treatment: { samples: 102881, ctr: 0.0921, cvr: 0.0227, gmv_per_user: 13.85, stay_sec: 41.6 },
        stat_sig:  { ctr: true, cvr: false, gmv_per_user: true, stay_sec: true },
      }),
    },
  },
  budget: { expectedSteps: 4, expectedTokens: 4500, expectedDurMs: 8000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /ctr|点击/i },
      { kind: 'answer-contains', value: /gmv/i },
      { kind: 'answer-contains', value: /放量|上线|建议|不建议/ },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /exp\/12345$/ } },
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
    llm: {
      question:
        '是否正确识别 ctr↑显著、gmv↑显著、cvr 不显著、stay 显著上涨？最终建议是否合理（应支持放量）？',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['chain', 'data-analysis'],
}
```

```ts
// L2-chain/exp-cross-validate.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/exp-cross-validate',
  level: 'L2',
  prompt:
    '我打开了一个实验后台 tab，同时这个实验在 API 上也能查。帮我比一下 API 数据和后台页面显示的数据是不是一致，不一致就指出哪条对不上。',
  fixtures: {
    snapshot: 'exp-dashboard-12345.html',
    tabs: ['exp-dashboard-12345.html'],
    fetchMap: {
      'https://exp.internal/api/exp/12345': JSON.stringify({
        name: '首页推荐改版 v3',
        control:   { ctr: 0.0843, cvr: 0.0231, gmv_per_user: 12.43, stay_sec: 38.2 },
        treatment: { ctr: 0.0921, cvr: 0.0227, gmv_per_user: 13.85, stay_sec: 41.6 },
      }),
    },
  },
  budget: { expectedSteps: 6, expectedTokens: 5500, expectedDurMs: 12000, maxSteps: 10 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /gmv/i },
      { kind: 'answer-contains', value: '13.85' },
      { kind: 'answer-contains', value: '13.50' },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet' },
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
      { kind: 'max-redundant-calls', name: 'readPage', max: 1 },
    ],
    llm: {
      question:
        '是否准确指出 gmv_per_user 在 API (13.85) 与 dashboard (13.50) 不一致？是否未对其他指标报假阳性？',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['chain', 'data-analysis', 'multi-tool', 'cross-source'],
}
```

- [ ] **Step 2: Append to suite index**

In `eval/tasks/index.ts`:

```ts
import { task as multiStepExtract }    from './L2-chain/multi-step-extract.task'
import { task as failThenFallback }    from './L2-chain/fail-then-fallback.task'
import { task as expTreatmentReadout } from './L2-chain/exp-treatment-readout.task'
import { task as expCrossValidate }    from './L2-chain/exp-cross-validate.task'

export const builtinSuite: Suite = [
  // ... existing L1 + earlier L2
  multiStepExtract, failThenFallback, expTreatmentReadout, expCrossValidate,
]
```

- [ ] **Step 3: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval/tasks   # PASS
git add packages/agent-kernel/eval/tasks
git commit -m "feat(kernel/eval): 4 more L2 tasks incl. data-analysis pair

Adds multi-step-extract, fail-then-fallback (recovery), and the two
e-commerce experiment readout tasks (exp-treatment-readout single-source
and exp-cross-validate API+dashboard reconciliation with intentional
gmv inconsistency).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: 4 L3 complex tasks + finalize suite

**Files (`L3-complex/`):**
- `skill-orchestration.task.ts` / `decomposition.task.ts` / `recover-and-replan.task.ts` / `exp-go-no-go.task.ts`

- [ ] **Step 1: Write 4 task files**

```ts
// L3-complex/skill-orchestration.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/skill-orchestration',
  level: 'L3',
  prompt:
    '用 summarizePage skill 总结当前页，然后把摘要里出现的人名分别在我打开的另外几个 tab 里查一下他们出现没。',
  fixtures: {
    snapshot: 'article.html',
    tabs: ['multi-tab-context/tab-a.html', 'multi-tab-context/tab-b.html'],
    skills: {
      summarizePage:
        '你是一个网页总结助手。读完页面后，输出 3 句话以内的摘要，列出文中提到的人名。',
    },
  },
  budget: { expectedSteps: 8, expectedTokens: 8000, expectedDurMs: 18000, maxSteps: 14 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: 'Alice' },
      { kind: 'answer-contains', value: 'Bob' },
    ],
    trace: [
      { kind: 'tool-called', name: 'useSkill', argsMatch: { name: 'summarizePage' } },
      { kind: 'tool-called', name: 'listTabs' },
      { kind: 'tool-called', name: 'readPage' },
    ],
    llm: {
      question:
        '是否正确总结了原文（讲 scaling agents），并准确报告 Alice 在 tab A 出现、Bob 在 tab B 出现？',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['complex', 'multi-tool', 'skill'],
}
```

```ts
// L3-complex/decomposition.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/decomposition',
  level: 'L3',
  prompt:
    '我想了解这个 PR 的影响范围：列出所有改动的文件，找出其中哪些是 test 文件，对应到测的是哪些 src 文件。',
  fixtures: {
    snapshot: 'pr-page.html',
    fetchMap: {
      'https://api.github.example/pr/88/files': JSON.stringify([
        { filename: 'src/parser.ts', additions: 40 },
        { filename: 'src/lexer.ts',  additions: 15 },
        { filename: 'tests/parser.test.ts', additions: 60 },
        { filename: 'tests/lexer.test.ts',  additions: 20 },
      ]),
    },
  },
  budget: { expectedSteps: 6, expectedTokens: 6000, expectedDurMs: 14000, maxSteps: 12 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /parser\.test\.ts/ },
      { kind: 'answer-contains', value: /src\/parser\.ts/ },
      { kind: 'answer-contains', value: /lexer/ },
    ],
    trace: [
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'tool-called', name: 'fetchGet' },
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
    llm: {
      question: '是否正确把 tests/parser.test.ts ↔ src/parser.ts 与 tests/lexer.test.ts ↔ src/lexer.ts 配对？',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['complex', 'decomposition', 'multi-tool'],
}
```

```ts
// L3-complex/recover-and-replan.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/recover-and-replan',
  level: 'L3',
  prompt: '帮我看看页面上 .nonexistent 元素的内容是什么。',
  fixtures: { snapshot: 'landing-page.html' },
  budget: { expectedSteps: 4, expectedTokens: 3500, expectedDurMs: 8000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /没有|无|not.*found|不存在|no match/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.nonexistent' } },
      { kind: 'max-redundant-calls', name: 'querySelector', max: 1 },
    ],
  },
  tags: ['complex', 'recovery'],
}
```

```ts
// L3-complex/exp-go-no-go.task.ts
import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/exp-go-no-go',
  level: 'L3',
  prompt:
    '我准备决定实验 12345 要不要放量。先看一下它本身的数据，再跟最近 3 个同类实验（首页推荐方向）对比，最后给我一个 go / no-go 的结论，要带理由。',
  fixtures: {
    tabs: ['exp-dashboard-12345.html'],
    fetchMap: {
      'https://exp.internal/api/exp/12345': JSON.stringify({
        name: '首页推荐改版 v3',
        treatment: { ctr: 0.0921, gmv_per_user: 13.85 },
        control:   { ctr: 0.0843, gmv_per_user: 12.43 },
        stat_sig:  { ctr: true, gmv_per_user: true },
      }),
      'https://exp.internal/api/exp/list?topic=home-rec&limit=3': JSON.stringify([
        { id: 11201, result: 'shipped',      lift_gmv:  0.072 },
        { id: 11455, result: 'shipped',      lift_gmv:  0.058 },
        { id: 11890, result: 'rolled_back',  lift_gmv: -0.012 },
      ]),
      'https://exp.internal/api/exp/11201': JSON.stringify({ name: 'rec v1', lift_gmv: 0.072 }),
      'https://exp.internal/api/exp/11455': JSON.stringify({ name: 'rec v2', lift_gmv: 0.058 }),
      'https://exp.internal/api/exp/11890': { body: '', status: 500, failOnce: false },
    },
  },
  budget: { expectedSteps: 12, expectedTokens: 12000, expectedDurMs: 25000, maxSteps: 20 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /go|放量|上线|不放量|no.?go|回滚/i },
      // Must reference at least one historical experiment id explicitly
      { kind: 'answer-contains', value: /11201|11455/ },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /exp\/12345$/ } },
      { kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /list\?topic=home-rec/ } },
      // Don't retry the failing 11890 endpoint more than once
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
    llm: {
      question:
        '结论是否引用了当前实验+至少一个历史实验数据？是否如实标注 11890 缺失而不是编造数据？建议在 ctr/gmv 双显著、且历史 lift_gmv ~6-7% 的语境下是否合理（应倾向 go）？',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['complex', 'data-analysis', 'multi-tool', 'decomposition', 'recovery'],
}
```

- [ ] **Step 2: Finalize suite index**

```ts
// packages/agent-kernel/eval/tasks/index.ts (final shape)
import type { Suite, Task } from '../core/types'

import { task as extractTitle }     from './L1-basic/extract-title.task'
import { task as extractSelection } from './L1-basic/extract-selection.task'
import { task as listTabs }         from './L1-basic/list-tabs.task'
import { task as getBySelector }    from './L1-basic/get-by-selector.task'
import { task as fetchJson }        from './L1-basic/fetch-json.task'
import { task as screenshot }       from './L1-basic/screenshot-describe.task'

import { task as issueSummary }        from './L2-chain/issue-summary.task'
import { task as crossTabCompare }     from './L2-chain/cross-tab-compare.task'
import { task as fetchThenExtract }    from './L2-chain/fetch-then-extract.task'
import { task as conditionalBranch }   from './L2-chain/conditional-branch.task'
import { task as multiStepExtract }    from './L2-chain/multi-step-extract.task'
import { task as failThenFallback }    from './L2-chain/fail-then-fallback.task'
import { task as expTreatmentReadout } from './L2-chain/exp-treatment-readout.task'
import { task as expCrossValidate }    from './L2-chain/exp-cross-validate.task'

import { task as skillOrchestration } from './L3-complex/skill-orchestration.task'
import { task as decomposition }      from './L3-complex/decomposition.task'
import { task as recoverAndReplan }   from './L3-complex/recover-and-replan.task'
import { task as expGoNoGo }          from './L3-complex/exp-go-no-go.task'

export const builtinSuite: Suite = [
  extractTitle, extractSelection, listTabs, getBySelector, fetchJson, screenshot,
  issueSummary, crossTabCompare, fetchThenExtract, conditionalBranch,
  multiStepExtract, failThenFallback, expTreatmentReadout, expCrossValidate,
  skillOrchestration, decomposition, recoverAndReplan, expGoNoGo,
]

// IDs that smoke mode runs (PR-time, with replay)
export const smokeIds: string[] = [
  ...['L1/extract-title', 'L1/extract-selection', 'L1/list-tabs',
      'L1/get-by-selector', 'L1/fetch-json', 'L1/screenshot-describe'],
  'L2/issue-summary',
  'L2/exp-treatment-readout',
]

export function filterSuite(
  suite: Suite,
  filter?: { levels?: Task['level'][]; tags?: string[]; ids?: string[] },
): Suite {
  if (!filter) return suite
  return suite.filter((t) => {
    if (filter.ids && !filter.ids.includes(t.id)) return false
    if (filter.levels && !filter.levels.includes(t.level)) return false
    if (filter.tags && !(t.tags ?? []).some((tag) => filter.tags!.includes(tag))) return false
    return true
  })
}
```

- [ ] **Step 3: Update suite test to expect 18**

```ts
// packages/agent-kernel/tests/eval/tasks/builtinSuite.test.ts (append)
import { builtinSuite, smokeIds, filterSuite } from '../../../eval/tasks/index'

it('has 18 tasks total: 6 L1 + 8 L2 + 4 L3', () => {
  expect(builtinSuite).toHaveLength(18)
  expect(builtinSuite.filter((t) => t.level === 'L1')).toHaveLength(6)
  expect(builtinSuite.filter((t) => t.level === 'L2')).toHaveLength(8)
  expect(builtinSuite.filter((t) => t.level === 'L3')).toHaveLength(4)
})

it('smokeIds all map to real tasks', () => {
  const ids = new Set(builtinSuite.map((t) => t.id))
  for (const id of smokeIds) expect(ids.has(id), id).toBe(true)
})

it('filterSuite by level/tag/ids works', () => {
  expect(filterSuite(builtinSuite, { levels: ['L3'] })).toHaveLength(4)
  expect(filterSuite(builtinSuite, { tags: ['data-analysis'] })).toHaveLength(3)
  expect(filterSuite(builtinSuite, { ids: ['L1/extract-title'] })).toHaveLength(1)
})
```

- [ ] **Step 4: Re-export from `eval/index.ts`**

```ts
// packages/agent-kernel/eval/index.ts
export type * from './core/types'
export { builtinSuite, smokeIds, filterSuite } from './tasks/index'
export { runSingleTask } from './core/runner'
export { runHardJudges } from './judges/hard'
export { runTraceJudges } from './judges/trace-shape'
export { runLlmJudge } from './judges/llm-judge'
export {
  makeFakeReadPage, makeFakeReadSelection, makeFakeQuerySelector,
  makeFakeListTabs, makeFakeScreenshot, makeFakeFetch, makeFakeUseSkill,
  allBuiltinFakes,
} from './fixtures/tools/index'
export { makeFixtureCtx, makeFsLoader } from './fixtures/ctx'
export { renderConsole } from './core/reporter/console'
export { renderJson } from './core/reporter/json'
export { renderMarkdown } from './core/reporter/markdown'
```

- [ ] **Step 5: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval   # all PASS
bun run typecheck
bun --cwd packages/mycli-web test
git add packages/agent-kernel/eval packages/agent-kernel/tests/eval
git commit -m "feat(kernel/eval): 4 L3 complex tasks + final builtinSuite (18) + barrel

L3 covers skill orchestration (multi-tool + skill body), decomposition
(PR analysis with file-pair matching), recover-and-replan (querying a
nonexistent selector), and exp-go-no-go (multi-source experiment readout
with one endpoint intentionally returning 500 to test recovery).
Public API surfaced via agent-kernel/eval barrel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — CLI / replay / CI

### Task 22: Record/replay LLM client wrapper

**Why:** Smoke mode needs deterministic offline runs. Wrap `OpenAICompatibleClient.streamChat` to either record outgoing messages → SSE chunks to disk, or replay from disk by `(taskId, callIndex)`.

**Files:**
- Create: `packages/agent-kernel/eval/replay/recorder.ts`
- Create: `packages/agent-kernel/eval/replay/player.ts`
- Test: `packages/agent-kernel/tests/eval/replay/recordReplay.test.ts`

- [ ] **Step 1: Tests (in-memory store, no fs)**

```ts
// packages/agent-kernel/tests/eval/replay/recordReplay.test.ts
import { describe, it, expect } from 'vitest'
import { wrapForRecord } from '../../../eval/replay/recorder'
import { wrapForReplay } from '../../../eval/replay/player'

const realLlm = {
  async *streamChat() {
    yield { kind: 'delta', text: 'hello' }
    yield { kind: 'done', stopReason: 'stop', usage: { in: 5, out: 1 } }
  },
} as any

describe('record + replay round-trip', () => {
  it('replay emits the same events the real client did during record', async () => {
    const store = new Map<string, unknown[]>()
    const recorded = wrapForRecord(realLlm, 'task-A', { put: (k, v) => store.set(k, v) })
    const evRecorded: any[] = []
    for await (const ev of recorded.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) evRecorded.push(ev)

    const replayed = wrapForReplay('task-A', { get: (k) => store.get(k) })
    const evReplayed: any[] = []
    for await (const ev of replayed.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) evReplayed.push(ev)
    expect(evReplayed).toEqual(evRecorded)
  })

  it('replay throws when request hash differs from recorded', async () => {
    const store = new Map<string, unknown[]>()
    const rec = wrapForRecord(realLlm, 'task-A', { put: (k, v) => store.set(k, v) })
    for await (const _ of rec.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    const replay = wrapForReplay('task-A', { get: (k) => store.get(k) })
    let threw = false
    try {
      for await (const _ of replay.streamChat({ messages: [{ role: 'user', content: 'CHANGED' }] })) { /* */ }
    } catch (e: any) {
      threw = true
      expect(e.message).toMatch(/hash/i)
    }
    expect(threw).toBe(true)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// packages/agent-kernel/eval/replay/recorder.ts
import type { OpenAICompatibleClient, StreamEvent, ChatRequest } from '../../src/core/OpenAICompatibleClient'

export interface FixtureStore {
  put: (key: string, value: unknown[]) => void
}

function reqHash(req: ChatRequest): string {
  // Stable hash: messages + tools shape, ignore signal
  const stable = JSON.stringify({
    messages: req.messages,
    tools: req.tools?.map((t) => ({ name: t.function.name, params: t.function.parameters })),
  })
  // simple FNV-1a 32-bit
  let h = 0x811c9dc5
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function wrapForRecord(
  inner: Pick<OpenAICompatibleClient, 'streamChat'>,
  taskId: string,
  store: FixtureStore,
): Pick<OpenAICompatibleClient, 'streamChat'> {
  let callIndex = 0
  return {
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      const key = `${taskId}/${callIndex++}/${reqHash(req)}`
      const buf: StreamEvent[] = []
      for await (const ev of inner.streamChat(req)) {
        buf.push(ev)
        yield ev
      }
      store.put(key, buf)
    },
  }
}
```

```ts
// packages/agent-kernel/eval/replay/player.ts
import type { StreamEvent, ChatRequest, OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

export interface FixtureReadStore {
  get: (key: string) => unknown[] | undefined
}

function reqHash(req: ChatRequest): string {
  const stable = JSON.stringify({
    messages: req.messages,
    tools: req.tools?.map((t) => ({ name: t.function.name, params: t.function.parameters })),
  })
  let h = 0x811c9dc5
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function wrapForReplay(
  taskId: string,
  store: FixtureReadStore,
): Pick<OpenAICompatibleClient, 'streamChat'> {
  let callIndex = 0
  return {
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      const key = `${taskId}/${callIndex++}/${reqHash(req)}`
      const recorded = store.get(key)
      if (!recorded) {
        throw new Error(`replay: no fixture for key=${key} (request hash mismatch — re-record this task)`)
      }
      for (const ev of recorded as StreamEvent[]) yield ev
    },
  }
}

/** Directory-backed store for CLI usage. */
export function makeFsReplayStore(dir: string): FixtureReadStore {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  return {
    get(key: string): unknown[] | undefined {
      const safe = key.replace(/[\/\\]/g, '__')
      const p = path.join(dir, `${safe}.json`)
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as unknown[]
      } catch {
        return undefined
      }
    },
  }
}

export function makeFsRecordStore(dir: string): { put: (k: string, v: unknown[]) => void } {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  fs.mkdirSync(dir, { recursive: true })
  return {
    put(key, value) {
      const safe = key.replace(/[\/\\]/g, '__')
      fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(value, null, 2), 'utf8')
    },
  }
}
```

- [ ] **Step 3: Run + export from barrel + commit**

In `eval/index.ts` add:

```ts
export { wrapForRecord } from './replay/recorder'
export { wrapForReplay, makeFsReplayStore, makeFsRecordStore } from './replay/player'
```

```bash
bun --cwd packages/agent-kernel test eval/replay   # PASS
git add packages/agent-kernel/eval/replay packages/agent-kernel/tests/eval/replay packages/agent-kernel/eval/index.ts
git commit -m "feat(kernel/eval): record/replay LLM wrapper

In-memory store + fs-backed store. Replay throws if the request hash
diverges from what was recorded — caller must re-record.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: `runEval` orchestrator + CLI + regression check

**Files:**
- Create: `packages/agent-kernel/eval/core/runEval.ts`
- Create: `packages/agent-kernel/eval/cli/eval.ts`
- Create: `packages/agent-kernel/eval/cli/checkRegression.ts`
- Test: `packages/agent-kernel/tests/eval/core/runEval.test.ts`

- [ ] **Step 1: Test for `runEval` aggregation**

```ts
// packages/agent-kernel/tests/eval/core/runEval.test.ts
import { describe, it, expect } from 'vitest'
import { runEvalCore } from '../../../eval/core/runEval'
import type { Task } from '../../../eval/core/types'

const tasks: Task[] = [
  {
    id: 'L1/a', level: 'L1', prompt: '', fixtures: {},
    judge: { completion: [{ kind: 'answer-contains', value: 'hi' }] },
    budget: { expectedSteps: 1, expectedTokens: 100, expectedDurMs: 1000, maxSteps: 3 },
    tags: ['t1'],
  },
  {
    id: 'L2/b', level: 'L2', prompt: '', fixtures: {},
    judge: { completion: [{ kind: 'answer-contains', value: 'bye' }] },
    budget: { expectedSteps: 1, expectedTokens: 100, expectedDurMs: 1000, maxSteps: 3 },
    tags: ['t1', 'data-analysis'],
  },
]

const llmStub = {
  async *streamChat() {
    yield { kind: 'delta', text: 'hi' }; yield { kind: 'done', stopReason: 'stop' }
  },
} as any

describe('runEvalCore', () => {
  it('aggregates totals + byLevel + byTag', async () => {
    const r = await runEvalCore({
      tasks, llm: llmStub, judgeLLM: undefined,
      buildTools: () => [],
    })
    expect(r.totals.passed).toBe(1)
    expect(r.totals.failed).toBe(1)
    expect(r.byLevel.L1.passed).toBe(1)
    expect(r.byLevel.L2.failed).toBe(1)
    expect(r.byTag['t1'].passed + r.byTag['t1'].failed).toBe(2)
    expect(r.byTag['data-analysis'].failed).toBe(1)
    expect(r.tasks).toHaveLength(2)
    expect(r.schemaVersion).toBe(1)
  })
})
```

- [ ] **Step 2: Implement `runEval.ts`**

```ts
// packages/agent-kernel/eval/core/runEval.ts
import { runSingleTask } from './runner'
import { runHardJudges } from '../judges/hard'
import { runTraceJudges } from '../judges/trace-shape'
import { runLlmJudge } from '../judges/llm-judge'
import { allBuiltinFakes } from '../fixtures/tools/index'
import { makeFixtureCtx, makeFsLoader } from '../fixtures/ctx'
import type {
  Suite, Task, TaskReport, SuiteReport, LlmConfig, ReporterId, TaskLevel,
} from './types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

export interface RunEvalCoreArgs {
  tasks: Suite
  llm: Pick<OpenAICompatibleClient, 'streamChat'>
  judgeLLM: Pick<OpenAICompatibleClient, 'streamChat'> | undefined
  buildTools?: (task: Task) => any[]   // injectable, defaults to allBuiltinFakes via FixtureCtx
  snapshotDir?: string
}

export async function runEvalCore(args: RunEvalCoreArgs): Promise<SuiteReport> {
  const startedAt = new Date().toISOString()
  const reports: TaskReport[] = []

  const buildTools = args.buildTools ?? ((task: Task) => {
    const loader = args.snapshotDir ? makeFsLoader(args.snapshotDir) : () => undefined
    const captionLoader = args.snapshotDir ? makeFsLoader(args.snapshotDir) : () => undefined
    const ctx = makeFixtureCtx(task, loader, captionLoader)
    return allBuiltinFakes.map((f) => f(ctx))
  })

  for (const task of args.tasks) {
    const r = await runSingleTask({
      task,
      llm: args.llm,
      judgeLLM: args.judgeLLM,
      buildTools: () => buildTools(task),
      runHardJudges: (t, tr) => runHardJudges(t, tr, new Map()),
      runTraceJudges: (t, tr) => runTraceJudges(t, tr),
      runLlmJudge: (t, tr, j) => runLlmJudge(t, tr, j),
    })
    reports.push(r)
  }

  // ── Aggregate ─────────────────────────────────────────────────
  const levels: TaskLevel[] = ['L1', 'L2', 'L3']
  const byLevel = Object.fromEntries(levels.map((l) => [l, { passed: 0, failed: 0, sum: 0, count: 0 }])) as Record<TaskLevel, { passed: number; failed: number; sum: number; count: number }>
  const byTagAcc = new Map<string, { passed: number; failed: number; sum: number; count: number }>()
  let passed = 0, failed = 0, sumComp = 0, sumTok = 0, sumSteps = 0
  for (const r of reports) {
    if (r.passed) passed++; else failed++
    sumComp += r.scores.composite
    sumTok  += r.trace.tokensIn + r.trace.tokensOut
    sumSteps += r.trace.steps.filter((s) => s.kind === 'tool-call').length
    const lvlAcc = byLevel[r.task.level]
    lvlAcc.passed += r.passed ? 1 : 0
    lvlAcc.failed += r.passed ? 0 : 1
    lvlAcc.sum += r.scores.composite
    lvlAcc.count++
    for (const tag of r.task.tags ?? []) {
      const acc = byTagAcc.get(tag) ?? { passed: 0, failed: 0, sum: 0, count: 0 }
      acc.passed += r.passed ? 1 : 0
      acc.failed += r.passed ? 0 : 1
      acc.sum += r.scores.composite
      acc.count++
      byTagAcc.set(tag, acc)
    }
  }
  const finalize = (a: { passed: number; failed: number; sum: number; count: number }) => ({
    passed: a.passed, failed: a.failed,
    meanComposite: a.count === 0 ? 0 : a.sum / a.count,
  })
  return {
    schemaVersion: 1,
    startedAt,
    llmModel: '(unknown)',
    totals: { passed, failed, skipped: 0 },
    byLevel: {
      L1: finalize(byLevel.L1), L2: finalize(byLevel.L2), L3: finalize(byLevel.L3),
    },
    byTag: Object.fromEntries(Array.from(byTagAcc.entries()).map(([k, v]) => [k, finalize(v)])),
    meanComposite: reports.length === 0 ? 0 : sumComp / reports.length,
    meanTokens: reports.length === 0 ? 0 : sumTok / reports.length,
    meanSteps: reports.length === 0 ? 0 : sumSteps / reports.length,
    tasks: reports,
  }
}

/** Public CLI entry. */
export interface RunEvalArgs {
  llm: LlmConfig
  judgeLLM?: LlmConfig
  suite: Suite
  filter?: { levels?: TaskLevel[]; tags?: string[]; ids?: string[] }
  reporter: ReporterId[]
  outDir: string
  recordTo?: string
  replayFrom?: string
  snapshotDir?: string
}

export async function runEval(args: RunEvalArgs): Promise<SuiteReport> {
  // Wires LlmConfig → OpenAICompatibleClient + optional record/replay,
  // calls runEvalCore, writes reporter outputs to outDir.
  // (Implementation omitted in this task; the CLI in cli/eval.ts assembles it.)
  throw new Error('runEval is wired in cli/eval.ts; use runEvalCore for programmatic use')
}
```

- [ ] **Step 3: Implement CLI `cli/eval.ts`**

```ts
// packages/agent-kernel/eval/cli/eval.ts
#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import { runEvalCore } from '../core/runEval'
import { wrapForRecord } from '../replay/recorder'
import { wrapForReplay, makeFsReplayStore, makeFsRecordStore } from '../replay/player'
import { renderConsole } from '../core/reporter/console'
import { renderJson } from '../core/reporter/json'
import { renderMarkdown } from '../core/reporter/markdown'
import { filterSuite, smokeIds } from '../tasks/index'
import type { Suite, RunOptions } from '../core/types'

interface ConfigModule {
  default: {
    llm: any; judgeLLM?: any; suite: Suite;
    reporter: ('console'|'markdown'|'json')[]; outDir: string;
  }
}

function parseArgs(argv: string[]) {
  const opts: { filter?: string; record?: boolean; replayFrom?: string; smoke?: boolean } = {}
  for (const a of argv) {
    if (a === '--record') opts.record = true
    else if (a === '--smoke') opts.smoke = true
    else if (a.startsWith('--filter=')) opts.filter = a.slice('--filter='.length)
    else if (a.startsWith('--replay-from=')) opts.replayFrom = a.slice('--replay-from='.length)
  }
  return opts
}

function buildFilter(s: string | undefined, smoke: boolean): RunOptions['filter'] {
  if (smoke) return { ids: smokeIds }
  if (!s) return undefined
  if (s.startsWith('id:'))   return { ids:    [s.slice(3)] }
  if (s.startsWith('tag:'))  return { tags:   [s.slice(4)] }
  if (s === 'L1' || s === 'L2' || s === 'L3') return { levels: [s] }
  return undefined
}

async function main() {
  const cwd = process.cwd()
  const configPath = path.join(cwd, 'eval-config.ts')
  if (!fs.existsSync(configPath)) {
    console.error(`No eval-config.ts in ${cwd}`)
    process.exit(2)
  }
  const cfg = (await import(configPath)) as ConfigModule
  const c = cfg.default
  const args = parseArgs(process.argv.slice(2))

  const tasks = filterSuite(c.suite, buildFilter(args.filter, args.smoke ?? false))
  if (tasks.length === 0) { console.error('No tasks matched filter'); process.exit(1) }

  const baseLlm = new OpenAICompatibleClient(c.llm)
  let llm: any = baseLlm
  let recorder: { flushPerTask: (id: string) => void } | undefined
  if (args.record) {
    const dir = path.join(c.outDir, 'replay', `${c.llm.model}-${new Date().toISOString().slice(0, 10)}`)
    const store = makeFsRecordStore(dir)
    // Wrap is per-task in runner; here we wrap factory inline:
    llm = (() => {
      const inner = baseLlm
      let currentTaskId = ''
      return {
        async *streamChat(req: any) {
          for await (const ev of wrapForRecord(inner, currentTaskId, store).streamChat(req)) yield ev
        },
        setTask: (id: string) => (currentTaskId = id),
      }
    })()
  } else if (args.replayFrom) {
    const store = makeFsReplayStore(args.replayFrom)
    llm = {
      async *streamChat(req: any) {
        // Replay needs per-task context — for v1, the runner only runs one task at a time so we set this in the main loop below
        // Implementation note: see Step 4
        for await (const ev of wrapForReplay((llm as any).__taskId ?? '', store).streamChat(req)) yield ev
      },
    }
  }

  const judgeLLM = c.judgeLLM ? new OpenAICompatibleClient(c.judgeLLM) : undefined

  const snapshotDir = path.join(__dirname, '..', 'fixtures', 'snapshots')
  const report = await runEvalCore({
    tasks, llm, judgeLLM, snapshotDir,
  })
  report.llmModel = c.llm.model

  fs.mkdirSync(c.outDir, { recursive: true })
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${c.llm.model}`
  const subdir = path.join(c.outDir, stamp)
  fs.mkdirSync(subdir, { recursive: true })
  for (const r of c.reporter) {
    if (r === 'console') console.log(renderConsole(report))
    if (r === 'markdown') fs.writeFileSync(path.join(subdir, 'report.md'),  renderMarkdown(report))
    if (r === 'json')     fs.writeFileSync(path.join(subdir, 'report.json'), renderJson(report))
  }
  // 'latest' symlink
  const latest = path.join(c.outDir, 'latest')
  try { fs.unlinkSync(latest) } catch {}
  try { fs.symlinkSync(stamp, latest, 'dir') } catch {}

  // Exit non-zero if any failed (so smoke can fail CI)
  process.exit(report.totals.failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

> **NOTE for the implementer:** the per-task taskId threading for record/replay is sketched but incomplete. Refactor `runEvalCore` to take a `wrapLlmForTask?: (taskId: string, llm) => llm` hook, and have the CLI pass through `wrapForRecord(inner, taskId, store)` / `wrapForReplay(taskId, store)` per task. Add a unit test in `runEval.test.ts` covering this hook.

- [ ] **Step 4: Implement `cli/checkRegression.ts`**

```ts
// packages/agent-kernel/eval/cli/checkRegression.ts
#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

function loadJson(p: string): any { return JSON.parse(fs.readFileSync(p, 'utf8')) }

function findReportJson(dir: string): string {
  // dir is like ./eval-out/latest — look for report.json directly inside
  const direct = path.join(dir, 'report.json')
  if (fs.existsSync(direct)) return direct
  throw new Error(`No report.json in ${dir}`)
}

function main() {
  const args = process.argv.slice(2)
  let baselinePath = ''
  let currentPath  = ''
  let threshold    = -0.05
  for (const a of args) {
    if (a.startsWith('--baseline=')) baselinePath = a.slice('--baseline='.length)
    else if (a.startsWith('--current=')) currentPath = a.slice('--current='.length)
    else if (a.startsWith('--threshold=')) threshold = Number(a.slice('--threshold='.length))
  }
  if (!baselinePath) baselinePath = 'eval/baseline.json'
  if (!currentPath)  currentPath  = findReportJson('eval-out/latest')
  const base = loadJson(baselinePath)
  const cur  = loadJson(currentPath)
  const delta = cur.meanComposite - base.meanComposite
  console.log(`baseline meanComposite=${base.meanComposite.toFixed(3)}`)
  console.log(`current  meanComposite=${cur.meanComposite.toFixed(3)}`)
  console.log(`delta=${delta.toFixed(3)} threshold=${threshold}`)
  if (delta < threshold) {
    console.error('REGRESSION: meanComposite dropped beyond threshold')
    process.exit(1)
  }
  console.log('OK: no regression')
}
main()
```

- [ ] **Step 5: Run + commit**

```bash
bun --cwd packages/agent-kernel test eval/core/runEval   # PASS
bun run typecheck
git add packages/agent-kernel/eval/core/runEval.ts packages/agent-kernel/eval/cli/ packages/agent-kernel/tests/eval/core/runEval.test.ts
git commit -m "feat(kernel/eval): runEval aggregator + CLI + regression check

CLI loads consumer's eval-config.ts, supports --filter / --record /
--replay-from / --smoke. Writes timestamped report directory + a
'latest' symlink. checkRegression compares meanComposite vs baseline
JSON; exits 1 if delta < threshold (default -0.05).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: Wire mycli-web `eval-config.ts` + npm scripts

**Files:**
- Create: `packages/mycli-web/eval-config.ts`
- Modify: `packages/mycli-web/package.json` (add scripts + dotenv)

- [ ] **Step 1: Write `eval-config.ts`**

```ts
// packages/mycli-web/eval-config.ts
import { builtinSuite } from 'agent-kernel/eval'
import type { LlmConfig } from 'agent-kernel/eval'

const llm: LlmConfig = {
  apiKey:  process.env.MYCLI_LLM_API_KEY  ?? '',
  baseUrl: process.env.MYCLI_LLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
  model:   process.env.MYCLI_LLM_MODEL    ?? 'glm-4.6',
  fetchTimeoutMs: 60_000,
}

const judgeLLM: LlmConfig | undefined = process.env.MYCLI_JUDGE_LLM_API_KEY
  ? {
      apiKey:  process.env.MYCLI_JUDGE_LLM_API_KEY,
      baseUrl: process.env.MYCLI_JUDGE_LLM_BASE_URL ?? llm.baseUrl,
      model:   process.env.MYCLI_JUDGE_LLM_MODEL    ?? 'glm-4.5-flash',
    }
  : undefined

export default {
  llm,
  judgeLLM,
  suite: builtinSuite,
  reporter: ['console', 'markdown', 'json'] as const,
  outDir: './eval-out',
}
```

- [ ] **Step 2: Add scripts**

In `packages/mycli-web/package.json`, append to `scripts`:

```json
"eval":                 "bun run --bun ../agent-kernel/eval/cli/eval.ts",
"eval:smoke":           "bun run --bun ../agent-kernel/eval/cli/eval.ts --smoke --replay-from=../agent-kernel/eval/fixtures/replay/latest",
"eval:check-regression":"bun run --bun ../agent-kernel/eval/cli/checkRegression.ts"
```

Add `eval-out/` and `.env*` to `packages/mycli-web/.gitignore` if not already present:

```
eval-out/
.env.local
```

- [ ] **Step 3: Smoke (no LLM): test config loads**

```bash
cd packages/mycli-web && bun run -- node -e "import('./eval-config.ts').then(c => console.log(Object.keys(c.default)))"
```

Expected: prints `[ 'llm', 'judgeLLM', 'suite', 'reporter', 'outDir' ]`.

- [ ] **Step 4: Commit**

```bash
git add packages/mycli-web/eval-config.ts packages/mycli-web/package.json packages/mycli-web/.gitignore
git commit -m "feat(mycli-web): wire agent-kernel/eval config + npm scripts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: GitHub Actions smoke workflow + first baseline

**Files:**
- Create: `.github/workflows/eval-smoke.yml`
- Create: `packages/agent-kernel/eval/baseline.json` (initial — generated on first full run)

- [ ] **Step 1: Workflow**

```yaml
# .github/workflows/eval-smoke.yml
name: Eval (smoke)
on:
  pull_request:
    paths:
      - 'packages/**'
      - '.github/workflows/eval-smoke.yml'
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.5'
      - run: bun install
      - run: bun run typecheck
      - run: bun --cwd packages/agent-kernel test
      - run: bun --cwd packages/mycli-web test
      - name: Eval smoke (replay)
        run: bun --cwd packages/mycli-web run eval:smoke
        env:
          # Replay mode does not actually call out — keys are dummies.
          MYCLI_LLM_API_KEY: replay-dummy
      - name: Regression vs baseline
        run: bun --cwd packages/mycli-web run eval:check-regression -- --baseline=../agent-kernel/eval/baseline.json
```

- [ ] **Step 2: Generate initial baseline (manual, off-CI)**

> **NOTE for the implementer:** This step needs a real LLM key. Run locally:

```bash
export MYCLI_LLM_API_KEY=...      # GLM key
export MYCLI_JUDGE_LLM_API_KEY=...
cd packages/mycli-web
bun run eval                       # full run, ~5-15min
cp eval-out/latest/report.json ../agent-kernel/eval/baseline.json
git add ../agent-kernel/eval/baseline.json
git commit -m "chore(kernel/eval): initial baseline.json from glm-4.6 full run

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Record smoke replay fixtures (manual, off-CI)**

```bash
cd packages/mycli-web
bun run eval -- --smoke --record   # writes eval-out/replay/<model>-<date>/
# move into kernel where checkRegression and CI expect them:
mv eval-out/replay/* ../agent-kernel/eval/fixtures/replay/
ln -sfn $(ls -t ../agent-kernel/eval/fixtures/replay | head -1) ../agent-kernel/eval/fixtures/replay/latest
git add ../agent-kernel/eval/fixtures/replay/
git commit -m "chore(kernel/eval): seed smoke replay fixtures

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Commit workflow**

```bash
git add .github/workflows/eval-smoke.yml
git commit -m "ci: eval smoke workflow on PR + main

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Final green check**

```bash
bun run typecheck
bun --cwd packages/agent-kernel test
bun --cwd packages/mycli-web test
```

All expected: PASS.

---

## Self-Review Notes

I checked this plan against the spec:

- **§1 layout**: T3 creates the directory; T4-T22 fill it. ✓
- **§2 interfaces**: T4 defines all of them. ✓
- **§3 scoring**: T6 implements. T16 amends `recovered: boolean` → `recoveryScore: 0|0.5|1` to fully match §3.2. ✓
- **§4 trace**: T5 (consumer) + T16 (recovery score). Uses existing async iterable instead of new `.on()` hook — explicitly noted at top of plan as a refinement. ✓
- **§5 18 tasks**: T18 (6 L1) + T19 (4 L2) + T20 (4 L2) + T21 (4 L3). ✓
- **§6 modes + reporters**: T8/9/10 (reporters) + T22 (replay) + T23 (CLI + smoke filter + regression check) + T25 (CI). ✓
- **§7 fixtures**: T11 (FixtureCtx) + T12/T13 (7 fakes) + T14 (12 snapshots). ✓
- **§8 kernel changes**: T1+T2 — narrower than spec (no `.on()`, just `usage` propagation). Documented at top.
- **§9 milestones**: spec lists 5 (M1-M5); this plan does 7 phases that map cleanly:
  - M1 → P1 (T1-T2)
  - M2 → P2-P3 (T3-T10)
  - M3 → P4 (T11-T14)
  - M4 → P5-P6 (T15-T21)
  - M5 → P7 (T22-T25)
- **§10 non-goals**: respected — no headless browser, no security, no LLM model eval.

**Type consistency:** `recovered: boolean` referenced in T6 + T7 is refactored to `recoveryScore` in T16 with explicit instructions to update both the scorer and the runner mapping. Test cases in T6 will need the rename — this is called out in T16 step 3.

**One known incomplete detail:** T23 step 3 has a per-task `taskId` threading note for record/replay. The implementer should refactor `runEvalCore` to expose a `wrapLlmForTask` hook before T24/T25 can run end-to-end. This is flagged inline in T23.

**Out of scope (deferred to future plans, per spec §10):**
- Page-clean variant of `L2/conditional-branch` (only error variant in v1, noted in T19)
- Auto-generation of `INDEX.md` from snapshot comments (manual file in T14)
- Sub-agent / code-skill eval categories (Tier 2 features in spec)

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-agent-eval-harness.md` (25 tasks, 7 phases).

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task or small batch (P1 alone, P2-P3 batched, P4 batched, P5 batched, P6 batched, P7 batched), review between batches. This is the same approach used for the kernel-extraction plan — fast, fresh context per task, easy to checkpoint.

**2. Inline Execution** — Execute tasks in this session using executing-plans, with checkpoints between phases for review.

Which approach?
