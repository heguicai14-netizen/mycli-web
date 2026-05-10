import { describe, it, expect } from 'vitest'
import { QueryEngine } from 'agent-kernel'
import type { OpenAICompatibleClient, StreamEvent } from 'agent-kernel'

function fakeClient(events: StreamEvent[][]): OpenAICompatibleClient {
  let i = 0
  return {
    async *streamChat() {
      const batch = events[i++] ?? []
      for (const ev of batch) yield ev
    },
  } as Pick<OpenAICompatibleClient, 'streamChat'> as OpenAICompatibleClient
}

describe('QueryEngine usage event', () => {
  it('emits assistant_message_complete with cumulative usage from this iteration', async () => {
    const client = fakeClient([
      [
        { kind: 'delta', text: 'done' },
        { kind: 'done', stopReason: 'stop', usage: { in: 100, out: 25 } },
      ],
    ])
    const engine = new QueryEngine({ client, tools: [], executeTool: async () => ({ ok: true, data: '' }) })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'hi' }])) out.push(ev)
    const complete = out.find((e) => e.kind === 'assistant_message_complete')
    expect(complete.usage).toEqual({ in: 100, out: 25 })
  })

  it('passes usage=undefined through cleanly when not present', async () => {
    const client = fakeClient([
      [{ kind: 'delta', text: 'hi' }, { kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({ client, tools: [], executeTool: async () => ({ ok: true, data: '' }) })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'hi' }])) out.push(ev)
    const complete = out.find((e) => e.kind === 'assistant_message_complete')
    expect(complete.usage).toBeUndefined()
  })

  it('does not bleed usage across iterations', async () => {
    const client = fakeClient([
      // Turn 1: model calls a tool, with usage
      [
        { kind: 'delta', text: 'thinking' },
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'noop', input: {} }],
          usage: { in: 10, out: 5 },
        },
      ],
      // Turn 2: final answer, no usage
      [
        { kind: 'delta', text: 'done' },
        { kind: 'done', stopReason: 'stop' },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [],
      executeTool: async () => ({ ok: true, data: '' }),
    })
    const completes: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) {
      if (ev.kind === 'assistant_message_complete') completes.push(ev)
    }
    expect(completes).toHaveLength(2)
    expect(completes[0].usage).toEqual({ in: 10, out: 5 })
    expect(completes[1].usage).toBeUndefined()
  })
})
