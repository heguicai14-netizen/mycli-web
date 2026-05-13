import { runSingleTask } from './runner'
import { runHardJudges } from '../judges/hard'
import { runTraceJudges } from '../judges/trace-shape'
import { runLlmJudge } from '../judges/llm-judge'
import { allBuiltinFakes } from '../fixtures/tools/index'
import { makeFixtureCtx, makeFsLoader } from '../fixtures/ctx'
import { evalSubagentTypes } from '../fixtures/subagentTypes'
import type {
  Suite, Task, TaskReport, SuiteReport, TaskLevel,
} from './types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import type { SubagentType } from '../../src/core/subagent'

export interface RunEvalCoreArgs {
  tasks: Suite
  llm: Pick<OpenAICompatibleClient, 'streamChat'>
  judgeLLM: Pick<OpenAICompatibleClient, 'streamChat'> | undefined
  buildTools?: (task: Task) => any[]   // injectable, defaults to allBuiltinFakes via FixtureCtx
  snapshotDir?: string
  wrapLlmForTask?: (taskId: string, llm: Pick<OpenAICompatibleClient, 'streamChat'>) => Pick<OpenAICompatibleClient, 'streamChat'>
  /** Sub-agent types injected into the runner. Enables the Task tool
   *  for L4 tasks. Default = evalSubagentTypes (general-purpose + explore). */
  subagentTypes?: readonly SubagentType[]
  /** Max number of tasks in flight concurrently. Default 1 = strict serial. */
  parallel?: number
  /** Forwarded to runSingleTask. Per-task wall-clock timeout (ms). */
  taskTimeoutMs?: number
}

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

export async function runEvalCore(args: RunEvalCoreArgs): Promise<SuiteReport> {
  const startedAt = new Date().toISOString()

  const parallel = Math.max(1, args.parallel ?? 1)
  const subagentTypes = args.subagentTypes ?? evalSubagentTypes
  const reports: TaskReport[] = new Array(args.tasks.length)

  async function runOne(item: { task: Task; idx: number }): Promise<void> {
    const { task, idx } = item
    try {
      const wrappedLlm = args.wrapLlmForTask ? args.wrapLlmForTask(task.id, args.llm) : args.llm
      // Build per-task FixtureCtx once so we can share its `state` Map between
      // fake tools (write side) and runHardJudges (read side for state-equals).
      let perTaskState: Map<string, unknown> = new Map()
      const buildTools = (t: Task) => {
        if (args.buildTools) return args.buildTools(t)
        const loader = args.snapshotDir ? makeFsLoader(args.snapshotDir) : () => undefined
        const captionLoader = args.snapshotDir ? makeFsLoader(args.snapshotDir) : () => undefined
        const ctx = makeFixtureCtx(t, loader, captionLoader)
        perTaskState = ctx.state
        return allBuiltinFakes.map((f) => f(ctx))
      }
      const report = await runSingleTask({
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
      // The QueryEngine catches LLM-level throws and converts them into a
      // `done` event with `stopReason: 'error'`, which `collectTrace` maps to
      // `abortReason: 'consumer'`. Treat that as a runtime failure so the
      // task is reported as failed even when scoring would otherwise pass it.
      if (report.trace.abortReason === 'consumer' && report.passed) {
        reports[idx] = {
          ...report,
          passed: false,
          failures: [...report.failures, 'runtime: llm-error (engine aborted)'],
        }
      } else {
        reports[idx] = report
      }
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

  // ── Aggregate ─────────────────────────────────────────────────
  const levels: TaskLevel[] = ['L1', 'L2', 'L3', 'L4']
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
      L1: finalize(byLevel.L1), L2: finalize(byLevel.L2), L3: finalize(byLevel.L3), L4: finalize(byLevel.L4),
    },
    byTag: Object.fromEntries(Array.from(byTagAcc.entries()).map(([k, v]) => [k, finalize(v)])),
    meanComposite: reports.length === 0 ? 0 : sumComp / reports.length,
    meanTokens: reports.length === 0 ? 0 : sumTok / reports.length,
    meanSteps: reports.length === 0 ? 0 : sumSteps / reports.length,
    tasks: reports,
  }
}
