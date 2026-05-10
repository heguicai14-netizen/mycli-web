import { describe, it, expect } from 'vitest'
import { ErrorCode, classifyError } from 'agent-kernel'

describe('classifyError', () => {
  it('classifies AbortError as Abort', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Abort)
    expect(c.retryable).toBe(false)
  })

  it('classifies LLM HTTP 401 as Auth', () => {
    const err = Object.assign(new Error('LLM HTTP 401'), { status: 401 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Auth)
    expect(c.retryable).toBe(false)
  })

  it('classifies LLM HTTP 429 as RateLimit (retryable)', () => {
    const err = Object.assign(new Error('LLM HTTP 429'), { status: 429 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.RateLimit)
    expect(c.retryable).toBe(true)
  })

  it('classifies LLM HTTP 500-599 as Server (retryable)', () => {
    const err = Object.assign(new Error('LLM HTTP 503'), { status: 503 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Server)
    expect(c.retryable).toBe(true)
  })

  it('classifies LLM HTTP 4xx (other) as BadRequest', () => {
    const err = Object.assign(new Error('LLM HTTP 400'), { status: 400 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.BadRequest)
    expect(c.retryable).toBe(false)
  })

  it('classifies messages with "timeout" as Timeout (retryable)', () => {
    const err = new Error('LLM fetch timeout after 60000ms')
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Timeout)
    expect(c.retryable).toBe(true)
  })

  it('classifies TypeError fetch failures as Network (retryable)', () => {
    const err = new TypeError('fetch failed')
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Network)
    expect(c.retryable).toBe(true)
  })

  it('falls back to Unknown for non-Error values', () => {
    const c = classifyError('weird string')
    expect(c.code).toBe(ErrorCode.Unknown)
    expect(c.message).toContain('weird string')
  })
})
