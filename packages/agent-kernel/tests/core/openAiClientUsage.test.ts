import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleClient } from 'agent-kernel'

function fakeFetch(sseChunks: string[]) {
  return async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of sseChunks) controller.enqueue(enc.encode(c))
        controller.close()
      },
    }),
    headers: new Headers(),
  }) as any
}

describe('OpenAICompatibleClient usage propagation', () => {
  let origFetch: typeof globalThis.fetch
  beforeEach(() => { origFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = origFetch })

  it('surfaces usage from final SSE chunk on done event', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    expect(done.usage).toEqual({ in: 42, out: 7 })
  })

  it('leaves usage undefined when endpoint omits it', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toBeUndefined()
  })
})
