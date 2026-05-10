import { describe, it, expect, vi } from 'vitest'
import { QueryEngine } from '@core/QueryEngine'
import type {
  OpenAICompatibleClient,
  StreamEvent,
} from '@core/OpenAICompatibleClient'

function fakeClient(scripts: StreamEvent[][]): OpenAICompatibleClient {
  let turn = 0
  return {
    async *streamChat() {
      const chunks = scripts[turn++] ?? []
      for (const c of chunks) yield c
    },
  } as any
}

describe('QueryEngine', () => {
  it('streams assistant delta and finishes on stop', async () => {
    const client = fakeClient([
      [
        { kind: 'delta', text: 'Hello' },
        { kind: 'delta', text: ' world' },
        { kind: 'done', stopReason: 'stop' },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [],
      executeTool: async () => ({
        ok: false,
        error: { code: 'no_tools', message: '', retryable: false },
      }),
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'hi' }])) events.push(ev)
    const text = events
      .filter((e) => e.kind === 'assistant_delta')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('Hello world')
    const done = events.find((e) => e.kind === 'done')
    expect(done.stopReason).toBe('end_turn')
  })

  it('runs a tool call and continues with tool result', async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true, data: { text: 'page content' } })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'readPage', input: { mode: 'text' } }],
        },
      ],
      [
        { kind: 'delta', text: 'The page says page content.' },
        { kind: 'done', stopReason: 'stop' },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [
        {
          type: 'function',
          function: { name: 'readPage', description: '', parameters: { type: 'object' } },
        },
      ],
      executeTool: exec,
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'what is on the page' }]))
      events.push(ev)
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0][0]).toEqual({
      id: 'c1',
      name: 'readPage',
      input: { mode: 'text' },
    })
    const finalText = events
      .filter((e) => e.kind === 'assistant_delta')
      .map((e) => e.text)
      .join('')
    expect(finalText).toContain('page content')
  })

  it('halts at toolMaxIterations', async () => {
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c0', name: 'noop', input: {} }],
        },
      ],
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'noop', input: {} }],
        },
      ],
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c2', name: 'noop', input: {} }],
        },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [
        { type: 'function', function: { name: 'noop', description: '', parameters: { type: 'object' } } },
      ],
      executeTool: async () => ({ ok: true, data: 'done' }),
      toolMaxIterations: 2,
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.stopReason).toBe('max_iterations')
  })

  it('forwards tool errors as tool_result with isError', async () => {
    const exec = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'no_active_tab', message: 'no tab', retryable: false },
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'readPage', input: {} }],
        },
      ],
      [{ kind: 'delta', text: 'sorry' }, { kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [
        {
          type: 'function',
          function: { name: 'readPage', description: '', parameters: { type: 'object' } },
        },
      ],
      executeTool: exec,
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'try' }])) events.push(ev)
    const tr = events.find((e) => e.kind === 'tool_result')
    expect(tr.isError).toBe(true)
  })
})
