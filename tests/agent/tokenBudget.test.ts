import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessageTokens } from '@/agent/query/tokenBudget'

describe('tokenBudget', () => {
  it('estimates 1 token per ~4 chars', () => {
    expect(estimateTokens('test')).toBe(1)
    expect(estimateTokens('test1234')).toBe(2)
  })
  it('handles empty and short', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
  })
  it('counts string content', () => {
    expect(estimateMessageTokens({ content: 'hello world!' })).toBe(3)
  })
  it('sums array content text parts', () => {
    expect(
      estimateMessageTokens({
        content: [
          { type: 'text', text: 'aaaa' },
          { type: 'text', text: 'bbbb' },
        ],
      }),
    ).toBe(2)
  })
  it('returns 0 for unknown shapes', () => {
    expect(estimateMessageTokens({ content: 12345 } as any)).toBe(0)
  })
})
