import { describe, it, expect } from 'vitest'
import { runHardJudges } from '../../../eval/judges/hard'
import type { Task, RunTrace } from '../../../eval/core/types'

const trace = (finalAnswer: string, _state?: Map<string, unknown>): RunTrace => ({
  taskId: 't', steps: [], finalAnswer,
  tokensIn: 0, tokensOut: 0, durationMs: 0,
})

const t = (assertions: any[]): Task => ({
  id: 't', level: 'L1', prompt: '', fixtures: {}, judge: { completion: assertions },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
})

describe('runHardJudges', () => {
  it('answer-contains string', () => {
    const r = runHardJudges(t([{ kind: 'answer-contains', value: 'foo' }]),
      trace('foo bar'), new Map())
    expect(r.passed).toBe(1); expect(r.total).toBe(1); expect(r.failures).toEqual([])
  })

  it('answer-contains regex', () => {
    const r = runHardJudges(t([{ kind: 'answer-contains', value: /\d+/ }]),
      trace('issue 1234'), new Map())
    expect(r.passed).toBe(1)
  })

  it('answer-equals', () => {
    const r = runHardJudges(t([{ kind: 'answer-equals', value: 'exact' }]), trace('exact'), new Map())
    expect(r.passed).toBe(1)
    const r2 = runHardJudges(t([{ kind: 'answer-equals', value: 'exact' }]), trace('not exact'), new Map())
    expect(r2.passed).toBe(0)
    expect(r2.failures[0]).toMatch(/answer-equals/)
  })

  it('answer-json-path', () => {
    const r = runHardJudges(t([{ kind: 'answer-json-path', path: '$.count', equals: 4 }]),
      trace('{"count":4,"items":[]}'), new Map())
    expect(r.passed).toBe(1)
  })

  it('state-equals via FixtureCtx state map', () => {
    const state = new Map<string, unknown>([['k', 'v']])
    const r = runHardJudges(t([{ kind: 'state-equals', key: 'k', value: 'v' }]), trace(''), state)
    expect(r.passed).toBe(1)
  })

  it('returns failures with actual values', () => {
    const r = runHardJudges(t([{ kind: 'answer-contains', value: 'foo' }]), trace('bar'), new Map())
    expect(r.passed).toBe(0)
    expect(r.failures[0]).toMatch(/answer-contains.*foo.*actual.*bar/)
  })

  it('reports zero asserts when none provided', () => {
    const r = runHardJudges({ ...t([]), judge: {} }, trace(''), new Map())
    expect(r.total).toBe(0); expect(r.passed).toBe(0)
  })
})
