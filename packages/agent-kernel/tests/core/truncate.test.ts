import { describe, it, expect } from 'vitest'
import { truncateForLLM } from '../../src/core/truncate'

describe('truncateForLLM', () => {
  it('returns content unchanged when under the limit', () => {
    expect(truncateForLLM('hello world', 100)).toBe('hello world')
  })

  it('returns content unchanged when at exactly the limit', () => {
    const s = 'a'.repeat(100)
    expect(truncateForLLM(s, 100)).toBe(s)
  })

  it('truncates and appends a marker mentioning the original size', () => {
    const s = 'a'.repeat(50_000)
    const out = truncateForLLM(s, 1000)
    expect(out.length).toBeLessThan(s.length)
    expect(out.startsWith('a'.repeat(1000))).toBe(true)
    expect(out).toContain('truncated by mycli-web')
    expect(out).toContain('original was 50000 chars')
    expect(out).toContain('showing first 1000')
  })

  it('treats undefined maxChars as no-op (safety bypass)', () => {
    const s = 'x'.repeat(100_000)
    expect(truncateForLLM(s, undefined)).toBe(s)
  })

  it('treats zero or negative maxChars as no-op', () => {
    const s = 'x'.repeat(1000)
    expect(truncateForLLM(s, 0)).toBe(s)
    expect(truncateForLLM(s, -10)).toBe(s)
  })

  it('handles empty content', () => {
    expect(truncateForLLM('', 100)).toBe('')
  })
})
