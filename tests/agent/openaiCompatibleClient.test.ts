import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleClient } from '@core/OpenAICompatibleClient'

const baseConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.test/v1',
  model: 'gpt-4o-mini',
}

function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('OpenAICompatibleClient.streamChat', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses SSE chunks into incremental text deltas', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n'
    ;(fetch as any).mockResolvedValue(makeStreamResponse([sse]))
    const client = new OpenAICompatibleClient(baseConfig)
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev)
    }
    const deltas = events.filter((e) => e.kind === 'delta').map((e) => e.text).join('')
    expect(deltas).toBe('Hello world')
    expect(events.some((e) => e.kind === 'done' && e.stopReason === 'stop')).toBe(true)
  })

  it('parses tool_calls in the stream', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"readPage","arguments":""}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"mode\\":\\"text\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n'
    ;(fetch as any).mockResolvedValue(makeStreamResponse([sse]))
    const client = new OpenAICompatibleClient(baseConfig)
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev)
    }
    const done = events.find((e) => e.kind === 'done')
    expect(done?.stopReason).toBe('tool_calls')
    expect(done?.toolCalls).toEqual([{ id: 'call_1', name: 'readPage', input: { mode: 'text' } }])
  })

  it('throws structured error on 401', async () => {
    ;(fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid_api_key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = new OpenAICompatibleClient(baseConfig)
    const fn = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.streamChat({ messages: [] })) {
        /* drain */
      }
    }
    await expect(fn()).rejects.toMatchObject({ status: 401 })
  })

  it('respects abort signal', async () => {
    const abort = new AbortController()
    const sse = 'data: {"choices":[{"delta":{"content":"slow"}}]}\n\n'
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
      },
      cancel() {
        cancelled = true
      },
    })
    ;(fetch as any).mockResolvedValue(new Response(stream, { status: 200 }))
    const client = new OpenAICompatibleClient(baseConfig)
    const iter = client.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      signal: abort.signal,
    })
    const collected: any[] = []
    const collector = (async () => {
      try {
        for await (const ev of iter) collected.push(ev)
      } catch {
        // expected
      }
    })()
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await collector
    expect(cancelled).toBe(true)
  })
})
