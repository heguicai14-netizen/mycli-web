import { describe, it, expect } from 'vitest'
import type { EngineEvent } from 'agent-kernel'
import { collectTrace } from '../../../eval/core/trace'

async function* events(...evs: EngineEvent[]): AsyncGenerator<EngineEvent> {
  for (const e of evs) yield e
}

describe('collectTrace', () => {
  it('translates assistant_message_complete + tool_executing + tool_result', async () => {
    const stream = events(
      { kind: 'assistant_delta', text: 'thinking...' },
      {
        kind: 'assistant_message_complete',
        text: 'I will read the page',
        toolCalls: [{ id: 'c1', name: 'readPage', input: {} }],
        usage: { in: 100, out: 20 },
      },
      { kind: 'tool_executing', call: { id: 'c1', name: 'readPage', input: {} } },
      { kind: 'tool_result', callId: 'c1', content: 'page text', isError: false },
      {
        kind: 'assistant_message_complete',
        text: 'The page says hi.',
        toolCalls: [],
        usage: { in: 50, out: 10 },
      },
      { kind: 'done', stopReason: 'end_turn' },
    )
    const trace = await collectTrace(stream, 'L1/test', 12345)
    expect(trace.taskId).toBe('L1/test')
    expect(trace.tokensIn).toBe(150)
    expect(trace.tokensOut).toBe(30)
    expect(trace.finalAnswer).toBe('The page says hi.')
    expect(trace.steps).toEqual([
      { kind: 'assistant-message', text: 'I will read the page' },
      { kind: 'tool-call', id: 'c1', name: 'readPage', args: {}, batchId: 'batch-1' },
      { kind: 'tool-result', id: 'c1', ok: true, data: 'page text' },
      { kind: 'assistant-message', text: 'The page says hi.' },
    ])
    expect(trace.durationMs).toBeGreaterThanOrEqual(0)
    expect(trace.abortReason).toBeUndefined()
  })

  it('marks abort when stop reason is max_iterations', async () => {
    const stream = events(
      { kind: 'assistant_message_complete', text: '', toolCalls: [] },
      { kind: 'done', stopReason: 'max_iterations' },
    )
    const trace = await collectTrace(stream, 'L1/abort', 0)
    expect(trace.abortReason).toBe('max-iter')
  })

  it('parses tool_result error JSON content into error string', async () => {
    const stream = events(
      {
        kind: 'assistant_message_complete',
        text: 'try fetch',
        toolCalls: [{ id: 'c1', name: 'fetchGet', input: { url: 'x' } }],
      },
      {
        kind: 'tool_result',
        callId: 'c1',
        content: JSON.stringify({ message: 'http 500' }),
        isError: true,
      },
      { kind: 'assistant_message_complete', text: 'failed', toolCalls: [] },
      { kind: 'done', stopReason: 'end_turn' },
    )
    const trace = await collectTrace(stream, 'L2/err', 0)
    const result = trace.steps.find((s) => s.kind === 'tool-result') as any
    expect(result.ok).toBe(false)
    expect(result.error).toContain('http 500')
  })

  it('preserves prior finalAnswer when a trailing empty assistant_message_complete arrives', async () => {
    const stream = events(
      { kind: 'assistant_message_complete', text: 'real answer', toolCalls: [], usage: { in: 5, out: 1 } },
      { kind: 'assistant_message_complete', text: '', toolCalls: [] },
      { kind: 'done', stopReason: 'end_turn' },
    )
    const trace = await collectTrace(stream, 't', 0)
    expect(trace.finalAnswer).toBe('real answer')
  })
})
