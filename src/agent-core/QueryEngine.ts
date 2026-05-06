import type {
  OpenAICompatibleClient,
  ChatMessage,
} from './OpenAICompatibleClient'
import type { ToolCall, ToolResult } from './types'

export type EngineEvent =
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'assistant_message_complete'; text: string; toolCalls: ToolCall[] }
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
          }
        }
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        yield { kind: 'done', stopReason: 'error', error: { code: 'llm_error', message: msg } }
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
      }

      if (stopReason !== 'tool_calls' || toolCallsFinal.length === 0) {
        yield { kind: 'done', stopReason: 'end_turn' }
        return
      }

      // Execute each tool call serially, push tool results back to history
      for (const call of toolCallsFinal) {
        yield { kind: 'tool_executing', call }
        const result = await this.opts.executeTool(call)
        const content = result.ok
          ? typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data)
          : JSON.stringify(result.error)
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content,
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
