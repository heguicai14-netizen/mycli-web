import type { EngineEvent } from '../../src/core/QueryEngine'
import type { SubagentEventInput } from '../../src/core/types'
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
 * - tool-call steps emitted by the same assistant_message_complete share a
 *   batchId so judges (e.g. subagent-parallel) can identify a parallel batch.
 * - subagentEvents (started/finished) are paired into subagent-spawn steps,
 *   appended at the end of trace.steps.
 */
export async function collectTrace(
  events: AsyncIterable<EngineEvent>,
  taskId: string,
  startedAt: number = Date.now(),
  subagentEvents: SubagentEventInput[] = [],
): Promise<RunTrace> {
  const trace: RunTrace = {
    taskId,
    steps: [],
    finalAnswer: '',
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
  }
  let batchCounter = 0
  for await (const ev of events) {
    if (ev.kind === 'assistant_message_complete') {
      if (ev.text) trace.steps.push({ kind: 'assistant-message', text: ev.text })
      if (ev.text) trace.finalAnswer = ev.text
      if (ev.usage) {
        trace.tokensIn += ev.usage.in
        trace.tokensOut += ev.usage.out
      }
      const batchId = ev.toolCalls.length > 0 ? `batch-${++batchCounter}` : undefined
      for (const call of ev.toolCalls) {
        trace.steps.push({
          kind: 'tool-call',
          id: call.id,
          name: call.name,
          args: call.input,
          batchId,
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

  // Pair subagent events into subagent-spawn steps (appended at end).
  const startedById = new Map<string, Record<string, unknown>>()
  const finishedById = new Map<string, Record<string, unknown>>()
  for (const ev of subagentEvents) {
    const sid = String((ev as Record<string, unknown>).subagentId ?? '')
    if (!sid) continue
    if (ev.kind === 'subagent/started') {
      startedById.set(sid, ev as Record<string, unknown>)
    } else if (ev.kind === 'subagent/finished') {
      finishedById.set(sid, ev as Record<string, unknown>)
    }
  }
  for (const [sid, started] of startedById) {
    const finished = finishedById.get(sid)
    if (finished) {
      const ok = Boolean(finished.ok)
      trace.steps.push({
        kind: 'subagent-spawn',
        subagentId: sid,
        type: String(started.subagentType ?? ''),
        prompt: String(started.prompt ?? ''),
        description: String(started.description ?? ''),
        parentCallId: String(started.parentCallId ?? ''),
        ok,
        finalText: ok ? String(finished.text ?? '') : undefined,
        error: !ok ? (finished.error as { code: string; message: string } | undefined) : undefined,
        iterations: Number(finished.iterations ?? 0),
      })
    } else {
      trace.steps.push({
        kind: 'subagent-spawn',
        subagentId: sid,
        type: String(started.subagentType ?? ''),
        prompt: String(started.prompt ?? ''),
        description: String(started.description ?? ''),
        parentCallId: String(started.parentCallId ?? ''),
        ok: false,
        error: { code: 'unfinished', message: 'subagent/started without matching subagent/finished' },
        iterations: 0,
      })
    }
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
