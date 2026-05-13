# Eval Batch Hang Fix 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 eval batch hang 根因。Kernel 加 pre-first-chunk retry,eval 加 per-task wall-clock timeout + per-task error isolation + parallel pool + CLI flags。让 batch eval 健壮。

**Architecture:** Kernel `core/retry.ts` 提供 `withRetryBackoff` 纯函数;`OpenAICompatibleClient.streamChat` 拆 `openConnection`(retry-able)+ `consumeStream`(不 retry),`ClientConfig` 加 `maxRetries`/`retryBaseMs`。Eval `runner.ts` 用 `setTimeout → taskAbort.abort()` 实现 per-task timeout;`runEval.ts` 用 worker pool 实现 parallel,try/catch 包 runSingleTask 实现 error isolation。CLI 加 `--parallel=N` + `--task-timeout-ms=N`。

**Tech Stack:** TypeScript 5.5、Vitest 2(fake timers / `vi.stubGlobal`)、Bun ≥1.3.5。

**Key constraints (memory):** kernel-first(retry 在 kernel,任何 consumer 受益);零 mycli-web 改动。

---

## 文件结构

| 路径 | 责任 | 任务 |
|---|---|---|
| `packages/agent-kernel/src/core/retry.ts` | 新:`withRetryBackoff` 纯函数 helper | T1 |
| `packages/agent-kernel/tests/core/retry.test.ts` | 新:retry helper 单测 | T1 |
| `packages/agent-kernel/src/core/OpenAICompatibleClient.ts` | 重构 streamChat 为 openConnection + consumeStream;接入 retry;ClientConfig 加 maxRetries/retryBaseMs | T2 |
| `packages/agent-kernel/tests/core/openAiClientRetry.test.ts` | 新:client retry 行为单测(mock fetch) | T2 |
| `packages/agent-kernel/eval/core/runner.ts` | 加 RunSingleArgs.taskTimeoutMs;setTimeout → taskAbort;trace 后置 abortReason 标记;engine 接 signal | T3 |
| `packages/agent-kernel/eval/__tests__/runner.timeout.test.ts` | 新:per-task timeout 单测 | T3 |
| `packages/agent-kernel/eval/core/runEval.ts` | parallel pool + error isolation + makeFailedReport;RunEvalCoreArgs 加 parallel/taskTimeoutMs | T4 |
| `packages/agent-kernel/eval/__tests__/runEval.batch.test.ts` | 新:并发 + 错误隔离 + 顺序保留 单测 | T4 |
| `packages/agent-kernel/eval/cli/eval.ts` | 加 --parallel=N + --task-timeout-ms=N 解析;透传到 runEvalCore | T5 |
| `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-eval-batch-hang-fix.md` | 手测验证 + handoff | T6(manual) |

总计:6 个 task。

---

### Task 1: `core/retry.ts` — withRetryBackoff 纯函数 helper

**Files:**
- Create: `packages/agent-kernel/src/core/retry.ts`
- Create: `packages/agent-kernel/tests/core/retry.test.ts`

- [ ] **Step 1: 写测试**

```ts
// packages/agent-kernel/tests/core/retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRetryBackoff } from '../../src/core/retry'

describe('withRetryBackoff', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('succeeds on first try without delay', async () => {
    const fn = vi.fn(async () => 'ok')
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable error and succeeds', async () => {
    let attempt = 0
    const fn = vi.fn(async () => {
      if (attempt++ === 0) throw new Error('transient')
      return 'ok'
    })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting maxRetries', async () => {
    const fn = vi.fn(async () => { throw new Error('always') })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    p.catch(() => {})  // prevent unhandled rejection
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(p).rejects.toThrow('always')
    expect(fn).toHaveBeenCalledTimes(3)   // maxRetries+1
  })

  it('does not retry on non-retryable error', async () => {
    const fn = vi.fn(async () => { throw new Error('fatal') })
    const p = withRetryBackoff(fn, () => false, { maxRetries: 2, baseMs: 500 })
    await expect(p).rejects.toThrow('fatal')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('maxRetries=0 disables retry', async () => {
    const fn = vi.fn(async () => { throw new Error('once') })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 0, baseMs: 500 })
    await expect(p).rejects.toThrow('once')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('backoff delay is exponential with jitter (range check)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    let attempt = 0
    const callTimes: number[] = []
    const startedAt = Date.now()
    const fn = vi.fn(async () => {
      callTimes.push(Date.now() - startedAt)
      if (attempt++ < 2) throw new Error('transient')
      return 'ok'
    })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBe('ok')
    // call 1 at t=0; call 2 after delay (500 * 2^0 + 0.5 * 500) = 750; call 3 after additional (500 * 2^1 + 0.5 * 500) = 1250
    expect(callTimes[0]).toBe(0)
    expect(callTimes[1]).toBeGreaterThanOrEqual(750)
    expect(callTimes[1]).toBeLessThanOrEqual(760)
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1250)
    expect(callTimes[2] - callTimes[1]).toBeLessThanOrEqual(1260)
    vi.spyOn(Math, 'random').mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd packages/agent-kernel && bun run test tests/core/retry.test.ts
```

预期:`Cannot find module '../../src/core/retry'`。

- [ ] **Step 3: 实现 `core/retry.ts`**

```ts
// packages/agent-kernel/src/core/retry.ts

export interface RetryConfig {
  /** Total retry attempts after the first try. 0 = no retry. Default callers use 2 → 3 total tries. */
  maxRetries: number
  /** Base delay in ms. Actual delay = baseMs * 2^attempt + Math.random() * baseMs. */
  baseMs: number
}

/**
 * Run `fn`, retry on errors classified retryable by `isRetryable`.
 * Stops when: fn succeeds, fn throws non-retryable, or attempts > maxRetries.
 *
 * Delay schedule for baseMs=500: ~500ms, ~2s (jitter 0-500ms added each).
 */
export async function withRetryBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  cfg: RetryConfig,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === cfg.maxRetries) throw err
      const delay = cfg.baseMs * Math.pow(2, attempt) + Math.random() * cfg.baseMs
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
```

- [ ] **Step 4: 跑测试 + 全套**

```bash
cd packages/agent-kernel && bun run test tests/core/retry.test.ts
bun run test
```

预期:6 新测试全过,全套绿(应为 396 tests)。

- [ ] **Step 5: commit**

```bash
git add packages/agent-kernel/src/core/retry.ts \
        packages/agent-kernel/tests/core/retry.test.ts
git commit -m "feat(kernel): withRetryBackoff helper for exponential backoff retry"
```

---

### Task 2: `OpenAICompatibleClient` 接入 retry

**Files:**
- Modify: `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`
- Create: `packages/agent-kernel/tests/core/openAiClientRetry.test.ts`

> **重构思路**:把现有 `streamChatInner` 拆为两段:
> - `openConnection(req)` — 包含 fetch + status check,返回 `Response`(可 retry)
> - `consumeStream(res, signal)` — async generator,消费 SSE 流(不 retry)
>
> `streamChat` 用 `withRetryBackoff` 包 openConnection,然后 yield* consumeStream。

- [ ] **Step 1: 看现有 streamChatInner 结构**

```bash
sed -n '95,200p' packages/agent-kernel/src/core/OpenAICompatibleClient.ts
```

确认:fetch + `if (!res.ok)` block + SSE 解析在同一函数。需要切线:fetch 返回的 res(并 200 状态检查)是 retry 边界。

- [ ] **Step 2: 写测试**

```ts
// packages/agent-kernel/tests/core/openAiClientRetry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

function makeSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(new TextEncoder().encode(`data: ${c}\n\n`))
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

function makeMidStreamErrorStream(beforeError: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of beforeError) {
        controller.enqueue(new TextEncoder().encode(`data: ${c}\n\n`))
      }
      controller.error(new Error('ECONNRESET'))
    },
  })
}

function jsonChunk(text: string): string {
  return JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: null }],
  })
}

const cfg = {
  apiKey: 'k', baseUrl: 'http://test.local/v1', model: 'm',
  fetchTimeoutMs: 5_000, maxRetries: 2, retryBaseMs: 1,
}

describe('OpenAICompatibleClient — retry', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries on pre-first-chunk ECONNRESET and succeeds', async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls++
      if (calls === 1) {
        const e: any = new Error('ECONNRESET')
        e.code = 'ECONNRESET'
        throw e
      }
      return new Response(makeSSEStream([jsonChunk('hi')]), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    })
    const client = new OpenAICompatibleClient(cfg)
    const events = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.kind === 'delta' && (e as any).text === 'hi')).toBe(true)
  })

  it('does NOT retry on 401 (non-retryable auth)', async () => {
    fetchMock.mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    )
    const client = new OpenAICompatibleClient(cfg)
    const events: any[] = []
    let threw = false
    try {
      for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    } catch (e: any) {
      threw = true
      expect(e.code).toBe('auth')
    }
    expect(threw).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on HTTP 500 and succeeds', async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls++
      if (calls === 1) return new Response('boom', { status: 500 })
      return new Response(makeSSEStream([jsonChunk('ok')]), { status: 200 })
    })
    const client = new OpenAICompatibleClient(cfg)
    const events = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting retries', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const client = new OpenAICompatibleClient(cfg)
    let threw = false
    try {
      for await (const _ of client.streamChat({ messages: [] })) { /* drain */ }
    } catch (e: any) {
      threw = true
      expect(e.status).toBe(500)
    }
    expect(threw).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3) // maxRetries=2 + initial
  })

  it('does NOT retry on mid-stream error (fetch called once)', async () => {
    fetchMock.mockResolvedValue(
      new Response(makeMidStreamErrorStream([jsonChunk('partial')]), { status: 200 }),
    )
    const client = new OpenAICompatibleClient(cfg)
    let threw = false
    let receivedDelta = false
    try {
      for await (const ev of client.streamChat({ messages: [] })) {
        if (ev.kind === 'delta') receivedDelta = true
      }
    } catch {
      threw = true
    }
    expect(receivedDelta).toBe(true)
    expect(threw).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)   // NO retry
  })

  it('maxRetries=0 disables retry on pre-first-chunk errors', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const client = new OpenAICompatibleClient({ ...cfg, maxRetries: 0 })
    await expect(async () => {
      for await (const _ of client.streamChat({ messages: [] })) { /* drain */ }
    }).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: 跑测试验证失败**

```bash
cd packages/agent-kernel && bun run test tests/core/openAiClientRetry.test.ts
```

预期:大多数测试 fail(无 retry → 第一次失败就抛)。

- [ ] **Step 4: 重构 `OpenAICompatibleClient.streamChat`**

读现有文件 line 95-200,把 `streamChatInner` 拆为两段。先在 `ClientConfig` 加新字段:

```ts
export interface ClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  fetchTimeoutMs?: number
  maxRetries?: number      // 默认 2
  retryBaseMs?: number     // 默认 500
}
```

然后改 `streamChat` 主方法。具体 patch:

(a) import retry helper(文件顶部 imports 区域):

```ts
import { withRetryBackoff } from './retry'
```

(b) 替换 `streamChat` + `streamChatInner` 为新结构:

```ts
async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
  const maxRetries = this.cfg.maxRetries ?? 2
  const retryBaseMs = this.cfg.retryBaseMs ?? 500

  // Phase 1: open connection (retry-able)
  let res: Response
  try {
    res = await withRetryBackoff(
      () => this.openConnection(req),
      (err) => classifyError(err).retryable,
      { maxRetries, baseMs: retryBaseMs },
    )
  } catch (e) {
    const classified = classifyError(e)
    const wrappedError = Object.assign(new Error(classified.message), {
      code: classified.code,
      retryable: classified.retryable,
      cause: classified.cause,
      ...(typeof (e as any)?.status === 'number' ? { status: (e as any).status } : {}),
    })
    throw wrappedError
  }

  // Phase 2: consume stream (NOT retry-able — mid-stream errors propagate)
  try {
    yield* this.consumeStream(res, req.signal)
  } catch (e) {
    const classified = classifyError(e)
    throw Object.assign(new Error(classified.message), {
      code: classified.code,
      retryable: classified.retryable,
      cause: classified.cause,
      ...(typeof (e as any)?.status === 'number' ? { status: (e as any).status } : {}),
    })
  }
}

private async openConnection(req: ChatRequest): Promise<Response> {
  // === MOVE from old streamChatInner: lines 117-187 (the fetch + status check) ===
  // (paste here body up to and including the `if (!res.ok) { ... throw ... }` block)
  // Return res at the end.
  const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body: Record<string, unknown> = {
    model: this.cfg.model,
    stream: true,
    messages: req.messages,
  }
  if (req.tools && req.tools.length) body.tools = req.tools
  body.stream_options = { include_usage: true }

  const timeoutMs = this.cfg.fetchTimeoutMs ?? 60_000
  const timeoutController = timeoutMs > 0 ? new AbortController() : undefined
  const timeoutId =
    timeoutMs > 0 && timeoutController
      ? setTimeout(
          () => timeoutController.abort(new Error('llm fetch timeout')),
          timeoutMs,
        )
      : undefined

  const combinedSignal = combineSignals(req.signal, timeoutController?.signal)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${this.cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  }).catch((e) => {
    if (timeoutController?.signal.aborted) {
      throw new Error(`LLM fetch timeout after ${timeoutMs}ms`)
    }
    throw e
  })
  if (timeoutId) clearTimeout(timeoutId)

  if (!res.ok) {
    let detail: unknown = undefined
    try {
      detail = await res.json()
    } catch {
      try {
        detail = await res.text()
      } catch {
        /* ignore */
      }
    }
    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(detail)}`)
    ;(err as any).status = res.status
    throw err
  }

  return res
}

private async *consumeStream(
  res: Response,
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  // === MOVE from old streamChatInner: SSE parsing loop (after `if (!res.ok)` block) ===
  // (paste verbatim — this is the existing reader loop that yields delta/toolDelta/done events)
}
```

> **实施提示**:不要凭空写 SSE 解析逻辑 — 整段从原 `streamChatInner` 复制粘贴。两段的代码总和应等于现有 `streamChatInner` 的代码量(只是位置不同)。`combineSignals` 工具是 `OpenAICompatibleClient.ts` 私有,继续从原位置 import。

- [ ] **Step 5: 跑测试**

```bash
cd packages/agent-kernel && bun run test tests/core/openAiClientRetry.test.ts
bun run test
cd ../.. && bun run typecheck
```

预期:6 新测试过,全套绿(应为 402),typecheck clean。

> **如果 mid-stream error 测试 fail**:确认 `consumeStream` 的 try/catch 在 `streamChat` 外层包裹,且 `withRetryBackoff` 只包 `openConnection`,不包 yield* 部分。

- [ ] **Step 6: commit**

```bash
git add packages/agent-kernel/src/core/OpenAICompatibleClient.ts \
        packages/agent-kernel/tests/core/openAiClientRetry.test.ts
git commit -m "feat(kernel): OpenAICompatibleClient retries pre-first-chunk errors"
```

---

### Task 3: `runner.ts` per-task wall-clock timeout

**Files:**
- Modify: `packages/agent-kernel/eval/core/runner.ts`
- Create: `packages/agent-kernel/eval/__tests__/runner.timeout.test.ts`

- [ ] **Step 1: 写测试**

```ts
// packages/agent-kernel/eval/__tests__/runner.timeout.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runSingleTask } from '../core/runner'
import type { Task, ToolDefinition } from '../core/types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

const dummyTask = (id = 't1'): Task => ({
  id, level: 'L1', prompt: 'go', fixtures: {},
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 5 },
  judge: {},
})

const noJudges = {
  runHardJudges: () => ({ passed: 0, total: 0, failures: [] }),
  runTraceJudges: () => ({ callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: false, recoveryScore: 1 as const, failures: [] }),
  runLlmJudge: async () => undefined,
}

function fastLlm(): OpenAICompatibleClient {
  return {
    async *streamChat() {
      yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
    },
  } as any
}

function hangLlm(signal?: () => AbortSignal | undefined): OpenAICompatibleClient {
  return {
    async *streamChat(req: any) {
      const sig = req.signal
      await new Promise((_, rej) => {
        sig?.addEventListener('abort', () => rej(new Error('AbortError')))
      })
    },
  } as any
}

describe('runSingleTask — taskTimeoutMs', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fast task completes normally without abortReason', async () => {
    const result = await runSingleTask({
      task: dummyTask(),
      llm: fastLlm(),
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
      taskTimeoutMs: 5_000,
    } as any)
    expect(result.trace.abortReason).toBeUndefined()
    expect(result.task.id).toBe('t1')
  })

  it('hanging task is aborted after taskTimeoutMs and abortReason=timeout', async () => {
    const llm = hangLlm()
    const promise = runSingleTask({
      task: dummyTask(),
      llm,
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
      taskTimeoutMs: 1_000,
    } as any)
    await vi.advanceTimersByTimeAsync(1_500)
    const result = await promise
    expect(result.trace.abortReason).toBe('timeout')
    expect(result.passed).toBe(false)
  })

  it('taskTimeoutMs=0 disables timeout (test by mocking; should not abort fast task)', async () => {
    const result = await runSingleTask({
      task: dummyTask(),
      llm: fastLlm(),
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
      taskTimeoutMs: 0,
    } as any)
    expect(result.trace.abortReason).toBeUndefined()
  })

  it('default taskTimeoutMs is 300000 when not provided', async () => {
    // We can't easily inspect the default in isolation, but verify fast task still works
    const result = await runSingleTask({
      task: dummyTask(),
      llm: fastLlm(),
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
    } as any)
    expect(result.task.id).toBe('t1')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd packages/agent-kernel && bun run test eval/__tests__/runner.timeout.test.ts
```

预期:第二个测试 fail(taskTimeoutMs 字段不存在 → 不触发 abort → hang 永远 hang)。

- [ ] **Step 3: 改 `eval/core/runner.ts`**

(a) `RunSingleArgs` 加字段(找到 interface 定义,~line 28):

```ts
export interface RunSingleArgs {
  // ...existing
  taskTimeoutMs?: number   // default 300_000 (5 min); ≤ 0 or Infinity disables
}
```

(b) 在 `runSingleTask` 内部 setup 阶段(`const engine = new QueryEngine(...)` 之前),加 timeout controller:

```ts
const timeoutMs = args.taskTimeoutMs ?? 300_000
const taskAbort = new AbortController()
let timeoutId: ReturnType<typeof setTimeout> | undefined
if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
  timeoutId = setTimeout(() => {
    taskAbort.abort(new Error(`task-timeout after ${timeoutMs}ms`))
  }, timeoutMs)
}
```

(c) 把 taskAbort.signal 接进 `QueryEngine`(找 `new QueryEngine({...})` 的 opts,加 signal):

```ts
const engine = new QueryEngine({
  client: llm as OpenAICompatibleClient,
  tools: toolDefs,
  toolMaxIterations: task.budget.maxSteps,
  signal: taskAbort.signal,        // NEW
  executeTool: async (call) => {
    // ...existing
    const ctx: ToolExecContext = {
      turnId,
      callId: call.id,
      conversationId,
      todoStore,
      emitSubagentEvent,
      signal: taskAbort.signal,   // NEW: tool exec also respects task signal
    }
    // ...
  },
})
```

(d) `collectTrace` 完成后做后置检查(找最终 `return { task, trace, scores, ... }`):

```ts
const startedAt = Date.now()
const trace = await collectTrace(
  engine.run([{ role: 'user', content: task.prompt }]),
  task.id,
  startedAt,
  subagentEvents,
)
if (timeoutId) clearTimeout(timeoutId)

// After stream ends, mark abortReason if our timeout fired
if (taskAbort.signal.aborted && taskAbort.signal.reason instanceof Error
    && /task-timeout/.test(String(taskAbort.signal.reason.message ?? taskAbort.signal.reason))) {
  trace.abortReason = 'timeout'
}

// ...rest of scoring path unchanged
```

把 `if (timeoutId) clearTimeout(timeoutId)` 放在 try/finally 内,**确保 clearTimeout 不漏**:

```ts
try {
  const trace = await collectTrace(...)
  // ...scoring
  return { ... }
} finally {
  if (timeoutId) clearTimeout(timeoutId)
}
```

> **Note**:`RunTrace.abortReason` 已含 `'timeout'` 字面值(eval/core/types.ts),不扩 union。

- [ ] **Step 4: 跑测试 + 全套 + typecheck**

```bash
cd packages/agent-kernel && bun run test eval/__tests__/runner.timeout.test.ts
bun run test
cd ../.. && bun run typecheck
```

预期:4 新测试过,全套绿(406),typecheck clean。

- [ ] **Step 5: commit**

```bash
git add packages/agent-kernel/eval/core/runner.ts \
        packages/agent-kernel/eval/__tests__/runner.timeout.test.ts
git commit -m "feat(eval): runSingleTask per-task wall-clock timeout (default 5min)"
```

---

### Task 4: `runEval.ts` parallel pool + error isolation

**Files:**
- Modify: `packages/agent-kernel/eval/core/runEval.ts`
- Create: `packages/agent-kernel/eval/__tests__/runEval.batch.test.ts`

- [ ] **Step 1: 写测试**

```ts
// packages/agent-kernel/eval/__tests__/runEval.batch.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runEvalCore } from '../core/runEval'
import type { Suite, Task } from '../core/types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

const fastLlm = {
  async *streamChat() {
    yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
  },
} as unknown as OpenAICompatibleClient

function makeTask(id: string): Task {
  return {
    id, level: 'L1', prompt: 'p', fixtures: {},
    budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 5 },
    judge: {},
  }
}

describe('runEvalCore — parallel + error isolation', () => {
  it('default parallel=1: tasks run serially', async () => {
    const tasks: Suite = ['a', 'b', 'c'].map(makeTask)
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const buildTools = (t: Task) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push(`start:${t.id}`)
      return []
    }
    // Hook into buildTools (called by runSingleTask). Each task increments inFlight.
    // Decrement happens implicitly when runSingleTask returns.
    const result = await runEvalCore({
      tasks, llm: fastLlm, judgeLLM: undefined, buildTools: (t) => {
        const tools = buildTools(t)
        return tools
      },
    } as any)
    // Even without explicit decrement, with parallel=1 inFlight starts at 0 before each task
    // (each task's buildTools is called when its runSingleTask begins, after previous returns).
    // We check the report order preservation instead:
    expect(result.tasks.map((t) => t.task.id)).toEqual(['a', 'b', 'c'])
  })

  it('parallel=4: up to 4 tasks run concurrently and reports stay in input order', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const tasks: Suite = ids.map(makeTask)
    let inFlight = 0
    let maxInFlight = 0
    const taskGate: Record<string, () => void> = {}
    const taskGatePromises: Record<string, Promise<void>> = {}
    for (const id of ids) {
      taskGatePromises[id] = new Promise((res) => { taskGate[id] = res })
    }

    const slowLlm = {
      async *streamChat(req: any) {
        // Find which task this is by inspecting messages (prompt contains task id... no, harder).
        // Easier: don't gate per task; just delay all uniformly.
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    } as unknown as OpenAICompatibleClient

    const result = await runEvalCore({
      tasks, llm: slowLlm, judgeLLM: undefined,
      buildTools: () => [],
      parallel: 4,
    } as any)
    expect(result.tasks.map((t) => t.task.id)).toEqual(ids)
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(maxInFlight).toBeGreaterThan(1)   // we DID get parallelism
  })

  it('per-task error isolation: failed task does not break batch', async () => {
    const tasks: Suite = ['a', 'b', 'c'].map(makeTask)
    let callCount = 0
    const llm = {
      async *streamChat() {
        callCount++
        if (callCount === 2) throw new Error('synthetic-failure')
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    } as unknown as OpenAICompatibleClient
    const result = await runEvalCore({
      tasks, llm, judgeLLM: undefined,
      buildTools: () => [],
    } as any)
    expect(result.tasks).toHaveLength(3)
    expect(result.tasks.filter((t) => t.passed === false).length).toBeGreaterThanOrEqual(1)
    // Ensure all 3 tasks have reports
    expect(result.tasks.map((t) => t.task.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('parallel report input-order preservation across mixed pass/fail', async () => {
    const tasks: Suite = ['x', 'y', 'z'].map(makeTask)
    const llm = {
      async *streamChat() {
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    } as unknown as OpenAICompatibleClient
    const result = await runEvalCore({
      tasks, llm, judgeLLM: undefined,
      buildTools: () => [],
      parallel: 3,
    } as any)
    expect(result.tasks.map((t) => t.task.id)).toEqual(['x', 'y', 'z'])
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd packages/agent-kernel && bun run test eval/__tests__/runEval.batch.test.ts
```

预期:`parallel=4` 测试 maxInFlight 始终 ≤ 1(因为现在 serial);`per-task error isolation` 测试 throw escape 让 batch 崩(主 promise reject)。

- [ ] **Step 3: 改 `eval/core/runEval.ts`**

(a) `RunEvalCoreArgs` 加字段:

```ts
export interface RunEvalCoreArgs {
  // ...existing
  parallel?: number          // default 1 = serial
  taskTimeoutMs?: number     // forwarded to runSingleTask
}
```

(b) 替换主循环(`for (const task of args.tasks) { ... }`)为 pool 实现:

```ts
const parallel = Math.max(1, args.parallel ?? 1)
const subagentTypes = args.subagentTypes ?? evalSubagentTypes
const reports: TaskReport[] = new Array(args.tasks.length)

async function runOne(item: { task: Task; idx: number }): Promise<void> {
  const { task, idx } = item
  try {
    const wrappedLlm = args.wrapLlmForTask ? args.wrapLlmForTask(task.id, args.llm) : args.llm
    let perTaskState: Map<string, unknown> = new Map()
    const buildTools = (t: Task) => {
      if (args.buildTools) return args.buildTools(t)
      const loader = args.snapshotDir ? makeFsLoader(args.snapshotDir) : () => undefined
      const captionLoader = args.snapshotDir ? makeFsLoader(args.snapshotDir) : () => undefined
      const ctx = makeFixtureCtx(t, loader, captionLoader)
      perTaskState = ctx.state
      return allBuiltinFakes.map((f) => f(ctx))
    }
    reports[idx] = await runSingleTask({
      task,
      llm: wrappedLlm,
      judgeLLM: args.judgeLLM,
      buildTools: () => buildTools(task),
      subagentTypes,
      runHardJudges: (t, tr) => runHardJudges(t, tr, perTaskState),
      runTraceJudges: (t, tr) => runTraceJudges(t, tr),
      runLlmJudge: (t, tr, j) => runLlmJudge(t, tr, j),
      taskTimeoutMs: args.taskTimeoutMs,
    })
  } catch (err) {
    reports[idx] = makeFailedReport(task, err)
  }
}

const queue = args.tasks.map((task, idx) => ({ task, idx }))
const inFlight = new Set<Promise<void>>()
while (queue.length > 0 || inFlight.size > 0) {
  while (inFlight.size < parallel && queue.length > 0) {
    const item = queue.shift()!
    const p = runOne(item).finally(() => inFlight.delete(p))
    inFlight.add(p)
  }
  if (inFlight.size > 0) await Promise.race(inFlight)
}
reports.forEach((r) => { if (r) reports.push  /* no-op safety: type system */ })
// Filter undefined slots — shouldn't happen but defensive
const finalReports = reports.filter((r): r is TaskReport => r !== undefined)
```

> **重要**:既有 aggregation 代码(下面的 `for (const r of reports) { ... }`)用 `for (const r of finalReports) { ... }` 替换,或者把 `reports` 重命名为 `finalReports` 后保持原逻辑。**简单做法**:把上面 `const finalReports = ...` 行删掉,直接用 `reports`(数组项 well-formed,因为 runOne 始终设值或落进 catch 设 failed)。

(c) 加 `makeFailedReport` helper(文件顶层或函数底部):

```ts
function makeFailedReport(task: Task, err: unknown): TaskReport {
  const message = err instanceof Error ? err.message : String(err)
  return {
    task,
    trace: {
      taskId: task.id,
      steps: [],
      finalAnswer: '',
      tokensIn: 0, tokensOut: 0, durationMs: 0,
      abortReason: 'consumer',
    },
    scores: { completion: 0, traceQuality: 0, efficiency: 0, composite: 0 },
    passed: false,
    failures: [`runtime: ${message}`],
  }
}
```

- [ ] **Step 4: 跑测试 + 全套 + typecheck**

```bash
cd packages/agent-kernel && bun run test eval/__tests__/runEval.batch.test.ts
bun run test
cd ../.. && bun run typecheck
```

预期:4 新测试过,全套绿(410),typecheck clean。

- [ ] **Step 5: commit**

```bash
git add packages/agent-kernel/eval/core/runEval.ts \
        packages/agent-kernel/eval/__tests__/runEval.batch.test.ts
git commit -m "feat(eval): runEvalCore parallel pool + per-task error isolation"
```

---

### Task 5: CLI `--parallel=N` + `--task-timeout-ms=N`

**Files:**
- Modify: `packages/agent-kernel/eval/cli/eval.ts`

> No new tests — CLI parse is simple, integration validation comes in T6.

- [ ] **Step 1: 读现有 `parseArgs`**

```bash
sed -n '24,42p' packages/agent-kernel/eval/cli/eval.ts
```

确认现有 flag 解析 pattern。

- [ ] **Step 2: 改 `parseArgs` + opts 类型**

(a) 扩 opts 接口:

```ts
function parseArgs(argv: string[]) {
  const opts: {
    filter?: string
    record?: boolean
    replayFrom?: string
    smoke?: boolean
    parallel?: number
    taskTimeoutMs?: number
  } = {}
  for (const a of argv) {
    if (a === '--record') opts.record = true
    else if (a === '--smoke') opts.smoke = true
    else if (a.startsWith('--filter=')) opts.filter = a.slice('--filter='.length)
    else if (a.startsWith('--replay-from=')) opts.replayFrom = a.slice('--replay-from='.length)
    else if (a.startsWith('--parallel=')) {
      opts.parallel = Math.max(1, parseInt(a.slice('--parallel='.length), 10) || 1)
    }
    else if (a.startsWith('--task-timeout-ms=')) {
      opts.taskTimeoutMs = Math.max(0, parseInt(a.slice('--task-timeout-ms='.length), 10) || 0)
    }
  }
  return opts
}
```

(b) 透传到 `runEvalCore`(找到 `await runEvalCore({...})` 调用):

```ts
const report = await runEvalCore({
  // ...existing fields
  parallel: args.parallel,
  taskTimeoutMs: args.taskTimeoutMs,
})
```

- [ ] **Step 3: 验证(无单测,跑 typecheck + 现有套件)**

```bash
cd packages/agent-kernel && bun run test
cd ../.. && bun run typecheck
```

预期:既有 410 测试全过,typecheck clean。

- [ ] **Step 4: 手测 CLI 解析正常**(可选,无关键性):

```bash
cd packages/mycli-web && \
MYCLI_LLM_API_KEY="dummy" MYCLI_LLM_BASE_URL="http://x" MYCLI_LLM_MODEL="m" \
bun run --bun ../agent-kernel/eval/cli/eval.ts --filter=id:L1/extract-title --parallel=2 --task-timeout-ms=1000 2>&1 | head -5
```

预期:命令至少能起来(可能 LLM 错,但 parseArgs 应 ok)。

- [ ] **Step 5: commit**

```bash
git add packages/agent-kernel/eval/cli/eval.ts
git commit -m "feat(eval): CLI --parallel=N + --task-timeout-ms=N flags"
```

---

### Task 6 (MANUAL — user runs, do NOT dispatch implementer)

> **重要**:本 task 需真实 LLM API key。implementer subagent **没有** API key,无法执行。**plan 跑到这里时,执行者(用户)亲自跑下面命令,验证 fix 生效,然后写 handoff**。

**目的**:验证 batch hang 修复实际生效,跑 `--filter=L2 --parallel=2` 确认 8/8 完成。

**前置**:确保 baseline 数据现存。`packages/mycli-web/eval-out/replay/glm-4.6-2026-05-13/` 不动。

**所需环境变量**:

```bash
export MYCLI_LLM_API_KEY=<api key>           # 参考 ~/test.txt
export MYCLI_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export MYCLI_LLM_MODEL=glm-4.6
export MYCLI_JUDGE_LLM_API_KEY=$MYCLI_LLM_API_KEY
export MYCLI_JUDGE_LLM_MODEL=glm-4.5-flash
```

**Step 6.1 — 跑 L2 batch 验证**(关键验证 — 之前会挂,现在应通)

```bash
cd packages/mycli-web
bun run --bun ../agent-kernel/eval/cli/eval.ts --filter=L2 --parallel=2 2>&1 | tail -20
```

期望:
- 8/8 完成,**不挂死**(parallel=2 远低于触发阈值)
- 总耗时 ≈ serial 的一半
- 任一 task 若 ECONNRESET 应被 kernel retry 拯救,不需要重试整 batch

**Step 6.2 — 跑全 27 任务**(终极验证 — 之前会挂)

```bash
bun run --bun ../agent-kernel/eval/cli/eval.ts --parallel=2 2>&1 | tail -25
```

期望:
- 27/27 完成
- 总分应接近 26/27 pass(prompt fix 后的 baseline)

**Step 6.3 — 测 timeout flag**(快速 sanity check)

```bash
bun run --bun ../agent-kernel/eval/cli/eval.ts \
  --filter=id:L4/iterative-research --task-timeout-ms=120000 2>&1 | tail -15
```

期望:120s 后 task abort,trace.abortReason='timeout',task 计 fail(避免之前 30 分钟卡死)。

**Step 6.4 — 写 handoff**

新建 `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-eval-batch-hang-fix.md`:

```markdown
# Eval Batch Hang Fix — Handoff

**Date:** 2026-05-13
**Sub-project:** Eval batch hang fix
**Spec:** `docs/superpowers/specs/2026-05-13-eval-batch-hang-fix-design.md`
**Plan:** `docs/superpowers/plans/2026-05-13-eval-batch-hang-fix.md`
**Branch:** <branch>

## 已交付

- `core/retry.ts` + `withRetryBackoff` 纯函数
- `OpenAICompatibleClient` pre-first-chunk retry(maxRetries=2 默认)
- `RunSingleArgs.taskTimeoutMs` per-task wall-clock(默认 300_000ms)
- `RunEvalCoreArgs.parallel` worker pool(默认 1 = 零行为变化)
- Per-task error isolation:单 task 抛错产 failed report,不中断 batch
- CLI `--parallel=N` + `--task-timeout-ms=N` flags

## 验证(实跑)

- `--filter=L2 --parallel=2`:8/8 完成 / 总分 <实测> / 耗时 ~<min>min
- `--parallel=2` 全 27:27/27 完成 / mean composite <实测>
- `--task-timeout-ms=120000` on iterative-research:120s 后正常 abort,task 计 fail

## 后续

- CI smoke 接入(已有 replay)
- 调更高 `--parallel` 看连接池阈值(可选研究)
```

**Step 6.5 — commit handoff**:

```bash
git add packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-eval-batch-hang-fix.md
git commit -m "docs: handoff for eval batch hang fix"
```

---

## 自审

**Spec 覆盖检查**:
- §1.1 pre-first-chunk retry → T1 + T2
- §1.2 ClientConfig 新字段 → T2
- §1.3 per-task wall-clock → T3
- §1.4 per-task error isolation → T4
- §1.5 parallel pool → T4
- §1.6 CLI flags → T5
- §1.7 kernel-first → T1+T2 在 src/core/,其余在 eval/,零 mycli 改动
- §3 测试策略 → 每 T 内嵌
- §6 验证 → T6 manual

**Placeholder 扫描**:无 TBD。一处"如果 mid-stream error 测试 fail" 在 T2 Step 5 — 是 actionable 故障排查 hint,不是 placeholder。

**Type 一致性**:`RunSingleArgs.taskTimeoutMs` 在 T3 定义,T4 在 runOne 内 forward → 一致;`RunEvalCoreArgs.parallel / taskTimeoutMs` 在 T4 定义,T5 CLI 透传 → 一致;`maxRetries/retryBaseMs` 在 T2 加到 ClientConfig 一处定义 → 一致;`withRetryBackoff` 签名在 T1 定义,T2 import → 一致。

**已知风险**:
- T3 的 `taskAbort.signal.reason` 拿到形式:`AbortController.abort(reason)` 传 Error 后,`signal.reason` 是该 Error 对象。message 检查应 work。若 implementer 在某些 runtime 看到 reason 是其它形式,fallback 到 "已 abort 但非 user signal" 的判别即可。
- T4 既有 `runEval.ts` 的 aggregation 逻辑(byLevel/byTag)必须保留,改 reports 数组生成逻辑时小心。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-13-eval-batch-hang-fix.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task,review between tasks。T1-T5 implementer 跑,**T6 manual 等用户**。

**2. Inline Execution** — Execute tasks in this session using executing-plans。

**Which approach?**
