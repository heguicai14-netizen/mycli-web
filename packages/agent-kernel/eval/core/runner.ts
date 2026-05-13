import { QueryEngine } from '../../src/core/QueryEngine'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import type {
  ToolDefinition,
  ToolExecContext,
  SubagentEventInput,
  ConversationId,
} from '../../src/core/types'
import { ToolRegistry } from '../../src/core/ToolRegistry'
import {
  buildSubagentTypeRegistry,
  buildTaskTool,
  type SubagentType,
} from '../../src/core/subagent'
import { todoWriteTool } from '../../src/core/tools/todoWrite'
import type { TodoStoreAdapter } from '../../src/adapters/TodoStoreAdapter'
import { InMemoryTodoStore } from './adapters/inMemoryTodoStore'
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
  /**
   * Optional sub-agent types. When non-empty, the `Task` tool is auto-injected
   * and wired with a registry built from this list.
   */
  subagentTypes?: readonly SubagentType[]
  /**
   * Optional todo store. If omitted, a fresh `InMemoryTodoStore` is auto-injected
   * when the task carries the `'todo'` tag. `todoWriteTool` is auto-pushed onto
   * the tools list when a store ends up wired in (unless the caller already
   * supplied one with the same name).
   */
  todoStore?: TodoStoreAdapter
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
  // Use the wide variant (any, any, any) so we can mix base-ctx tools from the
  // caller with kernel tools that read `ctx.todoStore` / `ctx.emitSubagentEvent`.
  const tools: Array<ToolDefinition<any, any, any>> = [...args.buildTools(task)]

  // Auto-inject TodoStore when task has 'todo' tag (unless caller provided one).
  const needsTodo = task.tags?.includes('todo') ?? false
  const todoStore: TodoStoreAdapter | undefined =
    args.todoStore ?? (needsTodo ? new InMemoryTodoStore() : undefined)
  if (todoStore && !tools.some((t) => t.name === 'todoWrite')) {
    tools.push(todoWriteTool)
  }

  // Auto-inject Task tool when subagentTypes is non-empty.
  if (args.subagentTypes && args.subagentTypes.length > 0) {
    const reg = buildSubagentTypeRegistry(args.subagentTypes)
    tools.push(buildTaskTool(reg, llm as OpenAICompatibleClient))
  }

  // Parent registry — used by the Task tool via the __taskParentRegistry back-door
  // so sub-agents inherit the parent's full tool surface.
  const parentRegistry = new ToolRegistry(tools)

  const toolDefs = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
  const toolByName = new Map(tools.map((t) => [t.name, t]))

  const turnId = crypto.randomUUID()
  const conversationId = `eval-${task.id}-${Date.now()}` as ConversationId
  const subagentEvents: SubagentEventInput[] = []
  const emitSubagentEvent = (ev: SubagentEventInput) => {
    subagentEvents.push(ev)
  }

  const engine = new QueryEngine({
    client: llm as OpenAICompatibleClient,
    tools: toolDefs,
    toolMaxIterations: task.budget.maxSteps,
    executeTool: async (call) => {
      const def = toolByName.get(call.name)
      if (!def) {
        return { ok: false, error: { code: 'no_such_tool', message: `no such tool: ${call.name}`, retryable: false } }
      }
      const ctx: ToolExecContext = {
        turnId,
        callId: call.id,
        conversationId,
        todoStore,
        emitSubagentEvent,
      }
      // Back-door so buildTaskTool's execute() can reach the parent registry
      // for sub-agent tool inheritance. Documented in src/core/subagent/taskTool.ts.
      ;(ctx as Record<string, unknown>).__taskParentRegistry = parentRegistry
      try {
        return await def.execute(call.input, ctx)
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
    subagentEvents,
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
