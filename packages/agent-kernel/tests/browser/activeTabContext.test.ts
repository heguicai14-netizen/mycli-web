import { describe, it, expect } from 'vitest'
import { buildActiveTabApprovalContext } from 'agent-kernel'

// setup.ts runs installChromeMock() in a beforeEach, giving us a real-ish
// chrome.tabs.query that returns [] by default. Per-test overrides simply
// reassign chrome.tabs.query on globalThis.chrome before calling the SUT.

describe('buildActiveTabApprovalContext', () => {
  it('returns origin + url from active tab', async () => {
    ;(globalThis as any).chrome.tabs.query = async () => [
      { url: 'https://example.com/path?q=1' },
    ]
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx.origin).toBe('https://example.com')
    expect(ctx.url).toBe('https://example.com/path?q=1')
  })

  it('returns empty object when no active tab (empty array)', async () => {
    ;(globalThis as any).chrome.tabs.query = async () => []
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx).toEqual({})
  })

  it('returns empty object when tab has no url', async () => {
    ;(globalThis as any).chrome.tabs.query = async () => [{ url: undefined }]
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx).toEqual({})
  })

  it('returns url-only when url cannot be parsed by URL constructor', async () => {
    // A malformed string that URL() rejects — keeps only url, no origin.
    const bad = 'not a url at all :::'
    ;(globalThis as any).chrome.tabs.query = async () => [{ url: bad }]
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx.url).toBe(bad)
    expect(ctx.origin).toBeUndefined()
  })

  it('returns empty object when chrome.tabs.query throws', async () => {
    ;(globalThis as any).chrome.tabs.query = async () => {
      throw new Error('permission denied')
    }
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx).toEqual({})
  })

  it('returns url-only when origin is opaque (about:blank)', async () => {
    ;(globalThis as any).chrome.tabs.query = async () => [{ url: 'about:blank' }]
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx.url).toBe('about:blank')
    expect(ctx.origin).toBeUndefined()
  })

  it('returns url-only when origin is opaque (data: URI)', async () => {
    ;(globalThis as any).chrome.tabs.query = async () => [{ url: 'data:text/html,<p>hi</p>' }]
    const ctx = await buildActiveTabApprovalContext()
    expect(ctx.url).toBe('data:text/html,<p>hi</p>')
    expect(ctx.origin).toBeUndefined()
  })
})
