import type {
  OpenAICompatibleClient,
  ChatMessage,
  NormalizedUsage,
} from './OpenAICompatibleClient'
import type { ToolCall, ToolResult, ToolDefinition } from './types'
import type { ApprovalContext, ApprovalCoordinator } from './approval'
import { truncateForLLM } from './truncate'

export type EngineEvent =
  | { kind: 'assistant_delta'; text: string }
  | {
      kind: 'assistant_message_complete'
      text: string
      toolCalls: ToolCall[]
      usage?: NormalizedUsage
    }
  | { kind: 'tool_executing'; call: ToolCall }
  | { kind: 'tool_result'; callId: string; content: string; isError: boolean }
  | {
      kind: 'done'
      stopReason: 'end_turn' | 'tool_use' | 'max_iterations' | 'cancel' | 'error'
      error?: { code: string; message: string }
    }

export interface QueryEngineOptions {
  client: OpenAICompatibleClient
  tools: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  executeTool: (call: ToolCall) => Promise<ToolResult>
  toolMaxIterations?: number
  systemPrompt?: string
  signal?: AbortSignal
  /**
   * Cap on tool result content (chars) inserted back into the LLM history
   * within the same turn. Full content is still surfaced via the
   * `tool_result` event for persistence/UI; only the LLM's view is truncated.
   * Undefined → no truncation.
   */
  toolMaxOutputChars?: number
  /** Definitions for the tools listed above. Needed to look up
   *  `requiresApproval` / `summarizeArgs` per call. Optional — when missing,
   *  approval is never triggered (back-compat). */
  toolDefinitions?: Array<ToolDefinition<any, any, any>>
  /** Approval coordinator. When set, requires sessionId. */
  approvalCoordinator?: ApprovalCoordinator
  /** Required when approvalCoordinator is set. Identifies the session for
   *  sticky decisions. */
  sessionId?: string
  /** Build ApprovalContext from the tool call. Sync or async. Default: {}. */
  buildApprovalContext?: (
    call: ToolCall,
  ) => ApprovalContext | Promise<ApprovalContext>
}

export class QueryEngine {
  constructor(private opts: QueryEngineOptions) {}

  async *run(initialMessages: ChatMessage[]): AsyncIterable<EngineEvent> {
    const max = this.opts.toolMaxIterations ?? 50
    const history: ChatMessage[] = []
    if (this.opts.systemPrompt) history.push({ role: 'system', content: this.opts.systemPrompt })
    history.push(...initialMessages)

    for (let iter = 0; iter < max; iter++) {
      let assistantText = ''
      let stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown' = 'stop'
      let toolCallsFinal: ToolCall[] = []
      let usageThisIter: NormalizedUsage | undefined

      try {
        for await (const ev of this.opts.client.streamChat({
          messages: history,
          tools: this.opts.tools.length ? this.opts.tools : undefined,
          signal: this.opts.signal,
        })) {
          if (ev.kind === 'delta') {
            assistantText += ev.text
            yield { kind: 'assistant_delta', text: ev.text }
          } else if (ev.kind === 'toolDelta') {
            // accumulation handled inside the client; we only consume the final list at 'done'
          } else if (ev.kind === 'done') {
            stopReason = ev.stopReason
            toolCallsFinal = (ev.toolCalls ?? []).map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.input,
            }))
            usageThisIter = ev.usage
          }
        }
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        yield {
          kind: 'done',
          stopReason: 'error',
          error: { code: e?.code ?? 'llm_error', message: msg },
        }
        return
      }

      // Push assistant message into history regardless of stop reason
      const assistantHistoryMsg: ChatMessage = {
        role: 'assistant',
        content: assistantText,
      }
      if (toolCallsFinal.length) {
        assistantHistoryMsg.tool_calls = toolCallsFinal.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        }))
      }
      history.push(assistantHistoryMsg)

      yield {
        kind: 'assistant_message_complete',
        text: assistantText,
        toolCalls: toolCallsFinal,
        usage: usageThisIter,
      }

      if (stopReason !== 'tool_calls' || toolCallsFinal.length === 0) {
        yield { kind: 'done', stopReason: 'end_turn' }
        return
      }

      // Execute each tool call serially, push tool results back to history
      for (const call of toolCallsFinal) {
        const def = this.opts.toolDefinitions?.find((t) => t.name === call.name)
        if (def?.requiresApproval && this.opts.approvalCoordinator) {
          if (!this.opts.sessionId) {
            throw new Error('QueryEngine: approvalCoordinator set without sessionId')
          }
          const ctx = (await this.opts.buildApprovalContext?.(call)) ?? {}
          const summary = def.summarizeArgs
            ? def.summarizeArgs(call.input)
            : JSON.stringify(call.input).slice(0, 200)
          const gateResult = await this.opts.approvalCoordinator.gate(
            { tool: call.name, args: call.input, ctx },
            summary,
            this.opts.sessionId,
            this.opts.signal,
          )
          if (gateResult === 'deny') {
            const denyContent = `User denied this tool call: ${call.name}.`
            yield { kind: 'tool_result', callId: call.id, content: denyContent, isError: true }
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              content: denyContent,
            })
            continue
          }
        }
        yield { kind: 'tool_executing', call }
        const result = await this.opts.executeTool(call)
        const content = result.ok
          ? typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data)
          : JSON.stringify(result.error)
        // The LLM-facing copy is truncated to keep one runaway tool call from
        // blowing the next iteration's prompt. The persistence/UI copy
        // (yielded below) stays full so users can still inspect everything.
        const llmContent = truncateForLLM(content, this.opts.toolMaxOutputChars)
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: llmContent,
        })
        yield {
          kind: 'tool_result',
          callId: call.id,
          content,
          isError: !result.ok,
        }
      }
    }

    yield { kind: 'done', stopReason: 'max_iterations' }
  }
}
