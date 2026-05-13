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
