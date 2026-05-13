# Eval Batch Hang Fix — 设计稿

**日期:** 2026-05-13
**Sub-project:** 引擎能力评估扩展的后续修复(基于 baseline run 实测发现的问题)
**状态:** 已批准,可进入 plan 阶段

## 1. 目标与非目标

### 目标(in-scope)

1. **Kernel: pre-first-chunk retry**。`OpenAICompatibleClient.streamChat` 在收到首 chunk **之前**抛 retryable error 时,自动 backoff retry。默认 2 次,exponential `500ms → 2s` + jitter。**首 chunk 之后任何错误直接抛**(避免双倍计费、避免 mid-stream 状态不一致)。
2. **Kernel: `ClientConfig` 新字段 `maxRetries?: number`(默认 2)、`retryBaseMs?: number`(默认 500,测试可注小值)**。
3. **Eval: per-task wall-clock timeout**。`runSingleTask` 内部 `setTimeout → taskAbort.abort()`,abort 信号传到 engine,trace 标 `abortReason: 'timeout'`,task 计 fail。默认 300_000ms (5 min),CLI `--task-timeout-ms=N` 可覆盖。
4. **Eval: per-task error isolation**。`runEval.ts` 主循环用 try/catch 包 `runSingleTask`,**单 task 异常**(包括 unhandled rejection、kernel 抛错)→ 产 standardized failed TaskReport,**不中断整 batch**。
5. **Eval: parallel pool**。`RunOptions.parallel`(已存在,未读)接入。`parallel = 1`(默认)= strict serial 零行为变化;`parallel > 1` 启用 worker pool,任意时刻在跑任务 ≤ N。完成顺序无关,最终 reports 按输入 task 顺序。
6. **CLI: `--parallel=N` + `--task-timeout-ms=N`** 两个新 flag。
7. **kernel-first**:retry 改动在 kernel `core/`,任何 consumer(包括 mycli-web 主路径)受益,零 mycli 引用。

### 非目标(v1 不做)

- Idle-stream watchdog(mid-stream 长时间无 chunk → abort)— 用 per-task wall-clock 兜底
- Mid-stream retry(双倍计费风险,已明确排除)
- LLM judge 调用单独 retry / timeout 策略(走同一 kernel client,共享 retry)
- 退化分析:不 root cause GLM 具体连接池/rate limit,纯靠"控并发避免触发"
- 多 endpoint / fallback model(纯单 endpoint 重试)
- 跨进程持久化重试状态(进程内 in-memory)
- 重写 `OpenAICompatibleClient.streamChat`(只重构两个内部方法,公共 API 保持)

## 2. 架构 / 改动分布

```
packages/agent-kernel/
├── src/core/
│   ├── OpenAICompatibleClient.ts     ← retry 接入 + ClientConfig 新字段
│   └── retry.ts                       ← 新:withRetryBackoff 纯函数 helper
└── tests/core/
    ├── retry.test.ts                  ← 新:backoff 单测
    └── openAiClientRetry.test.ts      ← 新:client retry 行为单测

packages/agent-kernel/eval/
├── core/
│   ├── runner.ts                      ← per-task wall-clock timeout
│   └── runEval.ts                     ← parallel pool + per-task error isolation
├── __tests__/
│   ├── runner.timeout.test.ts         ← 新
│   └── runEval.batch.test.ts          ← 新
└── cli/
    └── eval.ts                        ← --parallel=N + --task-timeout-ms=N
```

### 2.1 `core/retry.ts`(新文件,纯函数)

```ts
export interface RetryConfig {
  maxRetries: number          // 默认 2(总尝试次数 = 3)
  baseMs: number              // 默认 500
}

/** Run `fn`, retry on retryable errors with exponential backoff + jitter.
 *  Stops retrying when fn either succeeds, throws non-retryable, or attempts > maxRetries. */
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

`maxRetries: 2` → 总尝试 3 次,delay 序列 `~500ms, ~2s`(jitter `0-500ms` 叠加)。

### 2.2 `OpenAICompatibleClient` retry 接入

`streamChat` 拆为内部两段:`openConnection`(包含 fetch + status check,可 retry)+ `consumeStream`(SSE 流消费,不 retry)。

```ts
async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
  const maxRetries = this.cfg.maxRetries ?? 2
  const retryBaseMs = this.cfg.retryBaseMs ?? 500

  // Retry the connection phase only. Once we have the Response body,
  // we commit and never retry (mid-stream errors throw directly).
  const res: Response = await withRetryBackoff(
    () => this.openConnection(req),
    (err) => classifyError(err).retryable,
    { maxRetries, baseMs: retryBaseMs },
  )

  try {
    yield* this.consumeStream(res, req.signal)
  } catch (e) {
    // Mid-stream: do NOT retry, propagate as before
    const classified = classifyError(e)
    throw Object.assign(new Error(classified.message), {
      code: classified.code,
      retryable: classified.retryable,
      cause: classified.cause,
      ...(typeof (e as any)?.status === 'number' ? { status: (e as any).status } : {}),
    })
  }
}
```

**关键**:`openConnection` 包含 fetch + status check(401/500 等 HTTP 错误的 throw 也在这里),所以 HTTP 4xx/5xx 的 retry 也走 pre-first-chunk 路径,与"连接级 ECONNRESET 重试"语义一致。`consumeStream` 一旦开始 yield 内容,任何错误直抛。

`ClientConfig` 新增:

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

### 2.3 `runner.ts` per-task wall-clock timeout

```ts
export interface RunSingleArgs {
  // ...existing
  taskTimeoutMs?: number   // 默认 300_000 (5 min);≤ 0 视为 Infinity(禁用)
}

export async function runSingleTask(args): Promise<TaskReport> {
  // ...existing setup

  const timeoutMs = args.taskTimeoutMs ?? 300_000
  const taskAbort = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timeoutId = setTimeout(() => {
      taskAbort.abort(new Error(`task-timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  }

  try {
    // 把 taskAbort.signal 接入 QueryEngine。AgentSession.opts 已有 signal 字段;
    // 若 runner 已经传 signal,这里 chain;否则新增。
    const trace = await collectTrace(
      engine.run(initialMessages),
      task.id, startedAt, subagentEvents,
    )
    // After stream ends, check if it was aborted by our timeout:
    if (taskAbort.signal.aborted) {
      trace.abortReason = 'timeout'
    }
    // ... rest of scoring

    return { task, trace, scores, passed, failures }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
```

> **`RunTrace.abortReason='timeout'`** 已存在于 union,**不扩 schema**。

### 2.4 `runEval.ts` parallel pool + error isolation

```ts
const parallel = Math.max(1, args.parallel ?? 1)
const reports: TaskReport[] = new Array(args.tasks.length)
const queue = args.tasks.map((task, idx) => ({ task, idx }))
const inFlight = new Set<Promise<void>>()

async function runOne(item: { task: Task; idx: number }): Promise<void> {
  try {
    const wrappedLlm = args.wrapLlmForTask ? args.wrapLlmForTask(item.task.id, args.llm) : args.llm
    reports[item.idx] = await runSingleTask({
      task: item.task,
      llm: wrappedLlm,
      // ...其余 deps
      taskTimeoutMs: args.taskTimeoutMs,
    })
  } catch (err) {
    reports[item.idx] = makeFailedReport(item.task, err)
  }
}

while (queue.length > 0 || inFlight.size > 0) {
  while (inFlight.size < parallel && queue.length > 0) {
    const item = queue.shift()!
    const p = runOne(item).finally(() => inFlight.delete(p))
    inFlight.add(p)
  }
  if (inFlight.size > 0) await Promise.race(inFlight)
}
```

`makeFailedReport(task, err)` 产 TaskReport:零 trace + completion=0 + failures `[err.message]` + passed=false + scores 全 0。

**input 顺序保留**:`reports[item.idx]` 写,完成顺序无关。

`parallel = 1` 时 inFlight 始终 ≤ 1 → strict serial,零行为变化。

`RunEvalCoreArgs` 加 `parallel?: number` 和 `taskTimeoutMs?: number`。

### 2.5 CLI flags

`parseArgs` 加 2 个 case:

```ts
else if (a.startsWith('--parallel=')) {
  opts.parallel = Math.max(1, parseInt(a.slice('--parallel='.length), 10) || 1)
}
else if (a.startsWith('--task-timeout-ms=')) {
  opts.taskTimeoutMs = Math.max(0, parseInt(a.slice('--task-timeout-ms='.length), 10) || 0)
}
```

`runEvalCore` 的 args 透传:

```ts
await runEvalCore({
  // ...existing
  parallel: args.parallel,
  taskTimeoutMs: args.taskTimeoutMs,
})
```

## 3. 测试策略

### 3.1 Kernel 单测

**`tests/core/retry.test.ts`**(纯函数,用 fake timers):

| 用例 | 期望 |
|---|---|
| 第一次就 ok | `fn` 调 1 次,无 delay |
| 抛 retryable,第二次 ok | `fn` 调 2 次,有 1 次 delay |
| 抛 retryable 持续超 maxRetries | `fn` 调 `maxRetries+1` 次,最后抛 |
| 抛 non-retryable | `fn` 调 1 次,立即抛 |
| `maxRetries=0` | 等价 fn(),无 retry |
| Backoff 时长(用 fake timers + Math.random mock) | 第 N 次 delay 在 `[baseMs * 2^N, baseMs * 2^N + baseMs]` 区间内 |

**`tests/core/openAiClientRetry.test.ts`**:

mock `fetch` (`vi.stubGlobal('fetch', ...)`):

| 用例 | 期望 |
|---|---|
| pre-first-chunk ECONNRESET → 第二次成功 | `fetch` 调 2 次,正常 yield |
| pre-first-chunk 401 | 立即抛(non-retryable),`fetch` 调 1 次 |
| pre-first-chunk 500 → 第二次 200 | retry,`fetch` 调 2 次,正常 yield |
| pre-first-chunk 持续 500 超 maxRetries | 抛最后一次 error,`fetch` 调 `maxRetries+1` 次 |
| 首 chunk 之后 ECONNRESET | 直接抛,`fetch` 只被调一次 |
| 首 chunk 之后 abort | 抛 AbortError,不 retry |

mock SSE stream 用 `ReadableStream` 自定义,前 N chunk yield 后 controller.error()。

### 3.2 Eval 单测

**`__tests__/runner.timeout.test.ts`**:

| 用例 | 期望 |
|---|---|
| Task 跑得快(< timeout)| 正常完成,trace.abortReason undefined |
| Task 超时 | task abort,trace.abortReason='timeout',passed=false |
| `taskTimeoutMs=0` | 视为禁用,不 abort |
| 默认 timeoutMs(不传 args.taskTimeoutMs)| 走 300_000 默认 |

用 mock LLM 返回 hang stream + fake timers + 推进 timer 触发 abort。

**`__tests__/runEval.batch.test.ts`**:

| 用例 | 期望 |
|---|---|
| parallel=1(默认)| 序列执行(用 inFlight 计数 spy 验证 max=1)|
| parallel=4 | inFlight 最大达 4;reports 数和 input 数相等,**按 input task.id 顺序** |
| 单 task 在 `runSingleTask` 内抛 unhandled rejection | 不中断 loop,产 failed TaskReport,其他正常 |
| `runSingleTask` 跑 N 个任务,其中 M 个失败 | reports 数 = N,passed 数 = N - M |

测试用 mock `runSingleTask`(注入到 deps)+ 故意抛错的 stub 验证隔离。

### 3.3 集成验证(non-test,实跑)

实施完后用真实 LLM 跑:

```bash
bun run eval --filter=L2 --parallel=2
```

期望:
- 8/8 完成,不挂死
- 任一 task ECONNRESET 应被 retry 拯救
- 总耗时 ≈ serial 的 1/2

baseline 重测,不进单测套件。

### 3.4 不测什么

- 不模拟真实 GLM ECONNRESET 行为(不可重现)
- 不测 `--parallel=100` 极端值
- 不测多进程 / 多机分布式

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `withRetryBackoff` 测试用 fake timer + `Math.random` mock,jitter 实现细节波动 | 测试用范围断言而非精确 |
| `OpenAICompatibleClient` 拆 `openConnection` / `consumeStream` 重构有 regression 风险 | 既有 kernel 全套测试(390)必须全过;新增 retry test 不替换既有 streamChat 测试 |
| Per-task timeout 用 Promise.race 实现复杂(engine.run 是 async iterable) | 改用 setTimeout → taskAbort.abort(),让 abort 信号自然传播;trace 收集后置检查 abortReason |
| Pool 实现有 unhandled rejection 风险 | `runOne` 内部 try/catch 全包,确保 promise 不 reject 出 finally |
| Default `taskTimeoutMs=300_000` 对个别 L4 任务太紧 | 配置可覆盖:eval-config.ts / CLI flag / RunSingleArgs |
| Retry 默认开启可能改变生产 mycli-web 路径行为 | maxRetries 默认 2,小且 pre-first-chunk only;consumer 可设 `maxRetries=0` 关闭 |
| `RunEvalCoreArgs.parallel` 既有用户可能传了但没生效 | 既有 mycli-web 配置不传 parallel,行为不变 |

## 5. 最后清单

| # | 决策 |
|---|---|
| 1 | Pre-first-chunk only 重试 |
| 2 | maxRetries=2,baseMs=500,exponential + jitter |
| 3 | Idle watchdog **不做**(eval 层 wall-clock + 控并发) |
| 4 | Per-task wall-clock default 300_000ms |
| 5 | Per-task error isolation(try/catch 产 failed report) |
| 6 | Parallel pool with `parallel=1` default |
| 7 | CLI 加 `--parallel=N` + `--task-timeout-ms=N` |
| 8 | `RunOptions.parallel` 既有字段终于被读 |
| 9 | `RunTrace.abortReason='timeout'` 复用既有 union |
| 10 | Retry 在 kernel,timeout/pool 在 eval |
| 11 | 测试覆盖 ≈ 20 新测试 |

**预计实施 task 数**:6-7 个 task。

### 改动文件汇总

**新建**:
- `packages/agent-kernel/src/core/retry.ts`
- `packages/agent-kernel/tests/core/retry.test.ts`
- `packages/agent-kernel/tests/core/openAiClientRetry.test.ts`
- `packages/agent-kernel/eval/__tests__/runner.timeout.test.ts`
- `packages/agent-kernel/eval/__tests__/runEval.batch.test.ts`

**修改**:
- `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`
- `packages/agent-kernel/eval/core/runner.ts`
- `packages/agent-kernel/eval/core/runEval.ts`
- `packages/agent-kernel/eval/cli/eval.ts`

零 `packages/mycli-web/` 改动。

## 6. 明确排除(再次声明)

- Idle-stream watchdog
- Mid-stream retry
- Multi-endpoint / fallback model
- 跨进程持久化
- 重写 streamChat 公共 API
- `mycli-web` 任何改动
