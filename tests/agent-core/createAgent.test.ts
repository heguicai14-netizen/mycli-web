import { describe, it, expect } from 'vitest'
import { createAgent } from '@core'
import type { OpenAICompatibleClient, StreamEvent } from '@core/OpenAICompatibleClient'

function fakeClient(scripts: StreamEvent[][]): OpenAICompatibleClient {
  let turn = 0
  return {
    async *streamChat() {
      const chunks = scripts[turn++] ?? []
      for (const c of chunks) yield c
    },
  } as any
}

describe('createAgent', () => {
  it('streams message/streamChunk events for assistant deltas and ends with done', async () => {
    const agent = createAgent({
      llmClient: fakeClient([[
        { kind: 'delta', text: 'Hello' },
        { kind: 'delta', text: ' world' },
        { kind: 'done', stopReason: 'stop' },
      ]]),
      tools: [],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('hi')) events.push(ev)

    const chunks = events.filter((e) => e.kind === 'message/streamChunk').map((e) => e.delta)
    expect(chunks.join('')).toBe('Hello world')

    const last = events[events.length - 1]
    expect(last.kind).toBe('done')
    expect(last.stopReason).toBe('end_turn')
    expect(last.assistantText).toBe('Hello world')
  })

  it('seeds prior history via send opts', async () => {
    const agent = createAgent({
      llmClient: fakeClient([[
        { kind: 'delta', text: 'ack' },
        { kind: 'done', stopReason: 'stop' },
      ]]),
      tools: [],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('q2', {
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
    })) events.push(ev)

    const last = events[events.length - 1]
    expect(last.kind).toBe('done')
    expect(last.assistantText).toBe('ack')
  })

  it('cancel() aborts the in-flight LLM call', async () => {
    let aborted = false
    const agent = createAgent({
      llmClient: {
        async *streamChat({ signal }: any) {
          signal?.addEventListener('abort', () => { aborted = true })
          await new Promise((r) => setTimeout(r, 30))
          yield { kind: 'done', stopReason: 'stop' } as StreamEvent
        },
      } as any,
      tools: [],
      toolContext: {},
    })

    const it = agent.send('hi')[Symbol.asyncIterator]()
    setTimeout(() => agent.cancel(), 5)
    while (!(await it.next()).done) {}
    expect(aborted).toBe(true)
  })
})
