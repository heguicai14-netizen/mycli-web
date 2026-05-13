import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

function makeSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(new TextEncoder().encode(`data: ${c}\n\n`))
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

function makeMidStreamErrorStream(beforeError: string[]): ReadableStream<Uint8Array> {
  let pulled = false
  return new ReadableStream({
    // Pull-based: deliver chunks on first pull, error on second. This is portable
    // across stream implementations (Bun + browser) — calling controller.error()
    // synchronously in start() causes some impls to fail even the first read.
    pull(controller) {
      if (!pulled) {
        pulled = true
        for (const c of beforeError) {
          controller.enqueue(new TextEncoder().encode(`data: ${c}\n\n`))
        }
        return
      }
      controller.error(new Error('ECONNRESET'))
    },
  })
}

function jsonChunk(text: string): string {
  return JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: null }],
  })
}

const cfg = {
  apiKey: 'k',
  baseUrl: 'http://test.local/v1',
  model: 'm',
  fetchTimeoutMs: 5_000,
  maxRetries: 2,
  retryBaseMs: 1,
}

describe('OpenAICompatibleClient — retry', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries on pre-first-chunk ECONNRESET and succeeds', async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls++
      if (calls === 1) {
        const e: any = new Error('ECONNRESET')
        e.code = 'ECONNRESET'
        throw e
      }
      return new Response(makeSSEStream([jsonChunk('hi')]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const client = new OpenAICompatibleClient(cfg)
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.kind === 'delta' && (e as any).text === 'hi')).toBe(true)
  })

  it('does NOT retry on 401 (non-retryable auth)', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const client = new OpenAICompatibleClient(cfg)
    const events: any[] = []
    let threw = false
    try {
      for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    } catch (e: any) {
      threw = true
      expect(e.code).toBe('auth')
    }
    expect(threw).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on HTTP 500 and succeeds', async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls++
      if (calls === 1) return new Response('boom', { status: 500 })
      return new Response(makeSSEStream([jsonChunk('ok')]), { status: 200 })
    })
    const client = new OpenAICompatibleClient(cfg)
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting retries', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const client = new OpenAICompatibleClient(cfg)
    let threw = false
    try {
      for await (const _ of client.streamChat({ messages: [] })) {
        /* drain */
      }
    } catch (e: any) {
      threw = true
      expect(e.status).toBe(500)
    }
    expect(threw).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3) // maxRetries=2 + initial
  })

  it('does NOT retry on mid-stream error (fetch called once)', async () => {
    fetchMock.mockResolvedValue(
      new Response(makeMidStreamErrorStream([jsonChunk('partial')]), { status: 200 }),
    )
    const client = new OpenAICompatibleClient(cfg)
    let threw = false
    let receivedDelta = false
    try {
      for await (const ev of client.streamChat({ messages: [] })) {
        if (ev.kind === 'delta') receivedDelta = true
      }
    } catch {
      threw = true
    }
    expect(receivedDelta).toBe(true)
    expect(threw).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1) // NO retry
  })

  it('maxRetries=0 disables retry on pre-first-chunk errors', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const client = new OpenAICompatibleClient({ ...cfg, maxRetries: 0 })
    await expect(async () => {
      for await (const _ of client.streamChat({ messages: [] })) {
        /* drain */
      }
    }).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
