import { QueryEngine } from './QueryEngine'
import type { OpenAICompatibleClient, ChatMessage } from './OpenAICompatibleClient'
import type { ToolExecContext, ToolCall } from './types'
import type { AgentEvent } from './protocol'
import { ToolRegistry } from './ToolRegistry'
import type { ApprovalCoordinator, ApprovalContext } from './approval'

export interface AgentSessionOptions<ExtraCtx = Record<string, never>> {
  llmClient: OpenAICompatibleClient
  registry: ToolRegistry
  toolContext: ExtraCtx
  systemPrompt?: string
  toolMaxIterations?: number
  /** Forwarded to QueryEngine — see QueryEngineOptions.toolMaxOutputChars. */
  toolMaxOutputChars?: number
  /** Approval coordinator for gating tool calls that require user approval. */
  approvalCoordinator?: ApprovalCoordinator
  /** Session id — required when approvalCoordinator is set. */
  sessionId?: string
  /** Build ApprovalContext for each tool call. */
  buildApprovalContext?: (call: ToolCall) => ApprovalContext | Promise<ApprovalContext>
}

export class AgentSession<ExtraCtx = Record<string, never>> {
  private abort = new AbortController()
  private history: ChatMessage[] = []

  constructor(private opts: AgentSessionOptions<ExtraCtx>) {}

  cancel(): void {
    this.abort.abort()
  }

  async *send(
    text: string,
    opts?: { history?: ChatMessage[] },
  ): AsyncIterable<AgentEvent> {
    // Reset abort controller so a session that was previously cancelled can
    // still be reused (defensive — current consumer creates a new session per
    // chat turn, but the API shouldn't trap callers).
    if (this.abort.signal.aborted) {
      this.abort = new AbortController()
    }

    // Seed prior history on first send. Caller provides what was persisted
    // before this turn; we append the current user text on top.
    if (opts?.history && this.history.length === 0) {
      this.history.push(...opts.history)
    }
    this.history.push({ role: 'user', content: text })

    const engine = new QueryEngine({
      client: this.opts.llmClient,
      tools: this.opts.registry.toOpenAi(),
      executeTool: async (call: ToolCall) => {
        const def = this.opts.registry.get(call.name)
        if (!def) {
          return {
            ok: false,
            error: { code: 'unknown_tool', message: call.name, retryable: false },
          }
        }
        // Build ctx from caller-provided ExtraCtx; base ToolExecContext has only optional fields.
        const ctx = {
          ...(this.opts.toolContext as object),
        } as ToolExecContext & ExtraCtx
        return def.execute(call.input as any, ctx)
      },
      toolMaxIterations: this.opts.toolMaxIterations,
      systemPrompt: this.opts.systemPrompt,
      signal: this.abort.signal,
      toolMaxOutputChars: this.opts.toolMaxOutputChars,
      toolDefinitions: this.opts.registry.all(),
      approvalCoordinator: this.opts.approvalCoordinator,
      sessionId: this.opts.sessionId,
      buildApprovalContext: this.opts.buildApprovalContext,
    })

    let assistantText = ''

    for await (const ev of engine.run(this.history)) {
      if (ev.kind === 'assistant_delta') {
        assistantText += ev.text
        yield { kind: 'message/streamChunk', delta: ev.text }
      } else if (ev.kind === 'assistant_message_complete') {
        // Surface the iteration boundary so consumers can persist a dedicated
        // row per LLM completion. Empty-text iterations (the LLM only produced
        // tool calls) still get a row — needed for OpenAI replay shape where
        // a `tool` message must immediately follow the assistant message that
        // contains the matching tool_calls.
        yield {
          kind: 'assistant/iter',
          text: ev.text,
          toolCalls: ev.toolCalls,
        }
        if (ev.usage) {
          yield {
            kind: 'usage',
            input: ev.usage.in,
            output: ev.usage.out,
            ...(ev.usage.cached !== undefined ? { cached: ev.usage.cached } : {}),
          }
        }
      } else if (ev.kind === 'tool_executing') {
        yield {
          kind: 'tool/start',
          toolCall: { id: ev.call.id, tool: ev.call.name, args: ev.call.input },
        }
      } else if (ev.kind === 'tool_result') {
        yield {
          kind: 'tool/end',
          toolCallId: ev.callId,
          result: { ok: !ev.isError, content: ev.content },
        }
      } else if (ev.kind === 'done') {
        const sr = ev.stopReason
        const stopReason: 'end_turn' | 'tool_use' | 'max_iterations' | 'cancel' | 'error' =
          sr === 'end_turn' || sr === 'max_iterations' || sr === 'cancel' || sr === 'error'
            ? sr
            : 'end_turn'
        yield {
          kind: 'done',
          stopReason,
          assistantText,
          ...(ev.error ? { error: ev.error } : {}),
        }
      }
    }
  }
}
