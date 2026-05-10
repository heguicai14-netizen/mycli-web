import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchGetTool } from '@core/tools/fetchGet'

const ctx = {
  conversationId: 'c',
  tabId: 1,
  rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
} as any

describe('fetchGet', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns ok with body and content-type', async () => {
    ;(fetch as any).mockResolvedValue(
      new Response('{"a":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const r = await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.status).toBe(200)
      expect(r.data.contentType).toBe('application/json')
      expect(r.data.body).toBe('{"a":1}')
      expect(r.data.truncated).toBe(false)
    }
  })

  it('uses credentials: omit', async () => {
    ;(fetch as any).mockResolvedValue(new Response('', { status: 200 }))
    await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect((fetch as any).mock.calls[0][1].credentials).toBe('omit')
  })

  it('returns retryable error on network failure', async () => {
    ;(fetch as any).mockRejectedValue(new TypeError('network'))
    const r = await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.retryable).toBe(true)
  })

  it('truncates body over 200KB', async () => {
    const big = 'A'.repeat(300 * 1024)
    ;(fetch as any).mockResolvedValue(new Response(big, { status: 200 }))
    const r = await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.truncated).toBe(true)
      expect(r.data.body.length).toBe(200 * 1024)
    }
  })
})
