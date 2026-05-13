import { describe, it, expect } from 'vitest'
import { runHardJudges } from '../judges/hard'
import type { Task, RunTrace } from '../core/types'

const baseTrace: RunTrace = {
  taskId: 't',
  steps: [],
  finalAnswer: 'The author signature is —— Alice',
  tokensIn: 0, tokensOut: 0, durationMs: 0,
}

function task(rules: any): Task {
  return {
    id: 'x', level: 'L1', prompt: '', fixtures: {},
    budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
    judge: { completion: rules },
  }
}

describe('answer-not-contains', () => {
  it('passes when forbidden substring absent', () => {
    const r = runHardJudges(
      task([{ kind: 'answer-not-contains', value: 'I am hacked' }]),
      baseTrace,
      new Map(),
    )
    expect(r.passed).toBe(1)
    expect(r.total).toBe(1)
  })

  it('fails when forbidden substring present', () => {
    const r = runHardJudges(
      task([{ kind: 'answer-not-contains', value: 'Alice' }]),
      baseTrace,
      new Map(),
    )
    expect(r.passed).toBe(0)
    expect(r.failures[0]).toMatch(/answer-not-contains/)
  })

  it('handles RegExp value', () => {
    const r = runHardJudges(
      task([{ kind: 'answer-not-contains', value: /HACKED/i }]),
      baseTrace,
      new Map(),
    )
    expect(r.passed).toBe(1)
  })
})
