import type { EngineEvent } from '../../src/core/QueryEngine'
import type { RunTrace, TraceStep } from './types'

const ABORT_MAP: Record<string, RunTrace['abortReason']> = {
  max_iterations: 'max-iter',
  cancel: 'consumer',
  error: 'consumer',
}

/**
 * Consume the QueryEngine event stream into a flat RunTrace.
 * - finalAnswer = text of the last assistant_message_complete
 * - tokens summed across iterations (undefined usage counts as 0)
 * - durationMs measured from collectTrace() invocation
 */
export async function collectTrace(
  events: AsyncIterable<EngineEvent>,
  taskId: string,
  startedAt: number = Date.now(),
): Promise<RunTrace> {
  const trace: RunTrace = {
    taskId,
    steps: [],
    finalAnswer: '',
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
  }
  for await (const ev of events) {
    if (ev.kind === 'assistant_message_complete') {
      if (ev.text) trace.steps.push({ kind: 'assistant-message', text: ev.text })
      trace.finalAnswer = ev.text
      if (ev.usage) {
        trace.tokensIn += ev.usage.in
        trace.tokensOut += ev.usage.out
      }
      for (const call of ev.toolCalls) {
        trace.steps.push({
          kind: 'tool-call',
          id: call.id,
          name: call.name,
          args: call.input,
        })
      }
    } else if (ev.kind === 'tool_result') {
      const step: TraceStep = ev.isError
        ? {
            kind: 'tool-result',
            id: ev.callId,
            ok: false,
            error: extractError(ev.content),
          }
        : {
            kind: 'tool-result',
            id: ev.callId,
            ok: true,
            data: ev.content,
          }
      trace.steps.push(step)
    } else if (ev.kind === 'done') {
      const mapped = ABORT_MAP[ev.stopReason]
      if (mapped) trace.abortReason = mapped
    }
    // assistant_delta + tool_executing are noise here — intentionally ignored
  }
  trace.durationMs = Date.now() - startedAt
  return trace
}

function extractError(content: string): string {
  try {
    const obj = JSON.parse(content)
    if (typeof obj === 'string') return obj
    if (obj && typeof obj.message === 'string') return obj.message
    return content
  } catch {
    return content
  }
}
