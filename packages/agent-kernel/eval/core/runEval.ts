import { runSingleTask } from './runner'
import { runHardJudges } from '../judges/hard'
import { runTraceJudges } from '../judges/trace-shape'
import { runLlmJudge } from '../judges/llm-judge'
import { allBuiltinFakes } from '../fixtures/tools/index'
import { makeFixtureCtx, makeFsLoader } from '../fixtures/ctx'
import type {
  Suite, Task, TaskReport, SuiteReport, TaskLevel,
} from './types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

export interface RunEvalCoreArgs {
  tasks: Suite
  llm: Pick<OpenAICompatibleClient, 'streamChat'>
  judgeLLM: Pick<OpenAICompatibleClient, 'streamChat'> | undefined
  buildTools?: (task: Task) => any[]   // injectable, defaults to allBuiltinFakes via FixtureCtx
  snapshotDir?: string
  wrapLlmForTask?: (taskId: string, llm: Pick<OpenAICompatibleClient, 'streamChat'>) => Pick<OpenAICompatibleClient, 'streamChat'>
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
    const wrappedLlm = args.wrapLlmForTask ? args.wrapLlmForTask(task.id, args.llm) : args.llm
    const r = await runSingleTask({
      task,
      llm: wrappedLlm,
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
