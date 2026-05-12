import { describe, it, expect } from 'vitest'
import { defaultUsageParser } from 'agent-kernel'

describe('defaultUsageParser', () => {
  it('extracts cached from OpenAI/GLM shape', () => {
    const raw = { prompt_tokens_details: { cached_tokens: 100 } }
    expect(defaultUsageParser(raw)).toEqual({ cached: 100 })
  })

  it('extracts cached from DeepSeek shape', () => {
    const raw = { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }
    expect(defaultUsageParser(raw)).toEqual({ cached: 80 })
  })

  it('prefers OpenAI path when both shapes are present', () => {
    const raw = {
      prompt_tokens_details: { cached_tokens: 100 },
      prompt_cache_hit_tokens: 80,
    }
    expect(defaultUsageParser(raw)).toEqual({ cached: 100 })
  })

  it('returns cached=undefined for unknown shape', () => {
    expect(defaultUsageParser({ foo: 1 })).toEqual({ cached: undefined })
  })

  it('returns cached=undefined for null / undefined / non-object inputs', () => {
    expect(defaultUsageParser(null)).toEqual({ cached: undefined })
    expect(defaultUsageParser(undefined)).toEqual({ cached: undefined })
    expect(defaultUsageParser('foo')).toEqual({ cached: undefined })
    expect(defaultUsageParser(42)).toEqual({ cached: undefined })
  })

  it('returns cached=undefined when field type is wrong', () => {
    expect(
      defaultUsageParser({ prompt_tokens_details: { cached_tokens: 'oops' } }),
    ).toEqual({ cached: undefined })
    expect(defaultUsageParser({ prompt_cache_hit_tokens: null })).toEqual({
      cached: undefined,
    })
  })
})
