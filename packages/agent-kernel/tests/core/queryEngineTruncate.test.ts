import { describe, it, expect } from 'vitest'
import { QueryEngine } from 'agent-kernel'
import type { OpenAICompatibleClient, StreamEvent } from 'agent-kernel'

// Programmable fake LLM that records the message history sent on each
// streamChat invocation. Used to assert what the engine pushed in to history
// after a tool call.
function recorder(events: StreamEvent[][]) {
  const calls: any[] = []
  let i = 0
  const client = {
    async *streamChat(req: any) {
      calls.push(req.messages)
      const batch = events[i++] ?? []
      for (const ev of batch) yield ev
    },
  } as Pick<OpenAICompatibleClient, 'streamChat'> as OpenAICompatibleClient
  return { client, calls }
}

describe('QueryEngine tool result truncation', () => {
  it('truncates large tool results in same-turn LLM history but yields full content', async () => {
    const big = 'A'.repeat(40_000)
    const { client, calls } = recorder([
      // iter 1: LLM emits a tool call
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'readPage', input: {} }],
        },
      ],
      // iter 2: LLM produces final text
      [
        { kind: 'delta', text: 'done' },
        { kind: 'done', stopReason: 'stop' },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [],
      executeTool: async () => ({ ok: true, data: big }),
      toolMaxOutputChars: 1000,
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'q' }])) events.push(ev)

    // The yielded tool_result event carries the FULL content (for persistence/UI).
    const toolResult = events.find((e) => e.kind === 'tool_result')
    expect(toolResult.content).toBe(big)
    expect(toolResult.content.length).toBe(40_000)

    // But the second LLM call (iter 2) sees a TRUNCATED tool message.
    const iter2History = calls[1]
    const toolMsg = iter2History.find((m: any) => m.role === 'tool')
    expect(toolMsg.content.length).toBeLessThan(big.length)
    expect(toolMsg.content).toContain('truncated by mycli-web')
    expect(toolMsg.content).toContain('original was 40000 chars')
  })

  it('passes content through unchanged when toolMaxOutputChars is undefined', async () => {
    const big = 'B'.repeat(20_000)
    const { client, calls } = recorder([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'fetch', input: {} }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [],
      executeTool: async () => ({ ok: true, data: big }),
      // toolMaxOutputChars omitted = no truncation (kernel default)
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'q' }])) events.push(ev)

    const toolMsg = calls[1].find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toBe(big)
    expect(toolMsg.content).not.toContain('truncated')
  })
})
