import { QueryEngine } from '../../src/core/QueryEngine'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import type { ToolDefinition } from '../../src/core/types'
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
  recoveryScore: 0 | 0.5 | 1     // was: recovered: boolean
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
      parameters: t.inputSchema,
    },
  }))
  const toolByName = new Map(tools.map((t) => [t.name, t]))

  const engine = new QueryEngine({
    client: llm as OpenAICompatibleClient,
    tools: toolDefs,
    toolMaxIterations: task.budget.maxSteps,
    executeTool: async (call) => {
      const def = toolByName.get(call.name)
      if (!def) {
        return { ok: false, error: { code: 'no_such_tool', message: `no such tool: ${call.name}`, retryable: false } }
      }
      try {
        return await def.execute(call.input, {})
      } catch (e: any) {
        return { ok: false, error: { code: 'tool_error', message: String(e?.message ?? e), retryable: false } }
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
    recoveryScore: traceJ.recoveryScore,
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
    passed: passed(completion, comp, threshold),   // completion FIRST — matches T6 fix
    failures: [...hard.failures, ...traceJ.failures],
  }
}
