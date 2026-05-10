import { describe, it, expect } from 'vitest'
import { QueryEngine } from 'agent-kernel'

function fakeClient(events: any[][]) {
  let i = 0
  return {
    async *streamChat() {
      const batch = events[i++] ?? []
      for (const ev of batch) yield ev
    },
  } as any
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
})
