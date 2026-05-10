import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleClient } from 'agent-kernel'

describe('OpenAICompatibleClient fetch timeout', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('aborts the request after fetchTimeoutMs and surfaces a timeout error', async () => {
    // Mock fetch that never resolves
    globalThis.fetch = vi.fn((_url: any, init: any) => {
      return new Promise((resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted') as any
            err.name = 'AbortError'
            reject(err)
          })
        }
      })
    }) as any

    const client = new OpenAICompatibleClient({
      apiKey: 'test',
      baseUrl: 'http://x.local',
      model: 'm',
      fetchTimeoutMs: 100,
    })

    const start = Date.now()
    let caught: any
    try {
      const stream = client.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
      })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of stream) {
        // shouldn't get here
      }
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000) // honored timeout, didn't wait forever
    expect(caught).toBeDefined()
    expect(String(caught?.message ?? caught)).toMatch(/timeout|abort/i)
  })

  it('does not abort if fetchTimeoutMs is 0', async () => {
    let didAbort = false
    globalThis.fetch = vi.fn((_url: any, init: any) => {
      return new Promise(() => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            didAbort = true
          })
        }
      })
    }) as any

    const client = new OpenAICompatibleClient({
      apiKey: 'test',
      baseUrl: 'http://x.local',
      model: 'm',
      fetchTimeoutMs: 0,
    })
    const stream = client.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
    })
    // Race against a short timer; we expect the iteration not to abort within 200ms
    let gotEvent = false
    void (async () => {
      for await (const _ev of stream) {
        gotEvent = true
      }
    })()
    await new Promise((r) => setTimeout(r, 200))
    expect(didAbort).toBe(false)
    expect(gotEvent).toBe(false)
    // Cleanup: nothing — fetch promise hangs forever; vitest will move on
  }, 1000)
})
