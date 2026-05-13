import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRetryBackoff } from '../../src/core/retry'

describe('withRetryBackoff', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('succeeds on first try without delay', async () => {
    const fn = vi.fn(async () => 'ok')
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable error and succeeds', async () => {
    let attempt = 0
    const fn = vi.fn(async () => {
      if (attempt++ === 0) throw new Error('transient')
      return 'ok'
    })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting maxRetries', async () => {
    const fn = vi.fn(async () => { throw new Error('always') })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    p.catch(() => {})  // prevent unhandled rejection
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(p).rejects.toThrow('always')
    expect(fn).toHaveBeenCalledTimes(3)   // maxRetries+1
  })

  it('does not retry on non-retryable error', async () => {
    const fn = vi.fn(async () => { throw new Error('fatal') })
    const p = withRetryBackoff(fn, () => false, { maxRetries: 2, baseMs: 500 })
    await expect(p).rejects.toThrow('fatal')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('maxRetries=0 disables retry', async () => {
    const fn = vi.fn(async () => { throw new Error('once') })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 0, baseMs: 500 })
    await expect(p).rejects.toThrow('once')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('backoff delay is exponential with jitter (range check)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    let attempt = 0
    const callTimes: number[] = []
    const startedAt = Date.now()
    const fn = vi.fn(async () => {
      callTimes.push(Date.now() - startedAt)
      if (attempt++ < 2) throw new Error('transient')
      return 'ok'
    })
    const p = withRetryBackoff(fn, () => true, { maxRetries: 2, baseMs: 500 })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBe('ok')
    // call 1 at t=0; call 2 after delay (500 * 2^0 + 0.5 * 500) = 750; call 3 after additional (500 * 2^1 + 0.5 * 500) = 1250
    expect(callTimes[0]).toBe(0)
    expect(callTimes[1]).toBeGreaterThanOrEqual(750)
    expect(callTimes[1]).toBeLessThanOrEqual(760)
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1250)
    expect(callTimes[2] - callTimes[1]).toBeLessThanOrEqual(1260)
    vi.spyOn(Math, 'random').mockRestore()
  })
})
