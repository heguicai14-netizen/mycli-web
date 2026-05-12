import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

describe('OpenAICompatibleClient cached usage propagation', () => {
  let origFetch: typeof globalThis.fetch
  beforeEach(() => {
    origFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('surfaces cached from OpenAI-shape usage on done event', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49,"prompt_tokens_details":{"cached_tokens":30}},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 42, out: 7, cached: 30 })
  })

  it('surfaces cached from DeepSeek-shape usage', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":50,"completion_tokens":8,"prompt_cache_hit_tokens":40,"prompt_cache_miss_tokens":10},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 50, out: 8, cached: 40 })
  })

  it('leaves cached undefined when usage has no cache field', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":10,"completion_tokens":2},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 10, out: 2 })  // no cached field at all
  })

  it('custom usageParser overrides default', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"foo_cached":99},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
      usageParser: (raw: any) => ({ cached: raw?.foo_cached }),
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 10, out: 2, cached: 99 })
  })

  it('custom usageParser that throws degrades to undefined cached without breaking stream', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":10,"completion_tokens":2},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
      usageParser: () => {
        throw new Error('bad parser')
      },
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 10, out: 2 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
