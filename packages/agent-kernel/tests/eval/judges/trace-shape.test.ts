import { describe, it, expect } from 'vitest'
import { runTraceJudges } from '../../../eval/judges/trace-shape'
import type { Task, RunTrace, TraceStep } from '../../../eval/core/types'

const call = (id: string, name: string, args: unknown = {}): TraceStep => ({
  kind: 'tool-call', id, name, args,
})
const result = (id: string, ok: boolean): TraceStep => ({
  kind: 'tool-result', id, ok, ...(ok ? { data: 'x' } : { error: 'fail' }),
})
const trace = (steps: TraceStep[]): RunTrace => ({
  taskId: 't', steps, finalAnswer: '', tokensIn: 0, tokensOut: 0, durationMs: 0,
})
const T = (asserts: any[]): Task => ({
  id: 't', level: 'L1', prompt: '', fixtures: {}, judge: { trace: asserts },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
})

describe('runTraceJudges', () => {
  it('tool-called passes when present', () => {
    const r = runTraceJudges(T([{ kind: 'tool-called', name: 'readPage' }]),
      trace([call('1', 'readPage'), result('1', true)]))
    expect(r.callRate).toBe(1)
    expect(r.failures).toEqual([])
  })

  it('tool-called argsMatch is partial subset', () => {
    const r = runTraceJudges(T([{ kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /12345$/ } }]),
      trace([call('1', 'fetchGet', { url: 'http://x/exp/12345', extra: 1 }), result('1', true)]))
    expect(r.callRate).toBe(1)
  })

  it('tool-not-called fails when called', () => {
    const r = runTraceJudges(T([{ kind: 'tool-not-called', name: 'screenshot' }]),
      trace([call('1', 'screenshot'), result('1', true)]))
    expect(r.callRate).toBe(0)
    expect(r.failures[0]).toMatch(/tool-not-called/)
  })

  it('tool-order non-strict: only relative order matters', () => {
    const r = runTraceJudges(T([{ kind: 'tool-order', sequence: ['readPage', 'querySelector'] }]),
      trace([call('1', 'readPage'), result('1', true), call('2', 'querySelector'), result('2', true)]))
    expect(r.callRate).toBe(1)
  })

  it('tool-order strict: exact sequence', () => {
    const r = runTraceJudges(T([{ kind: 'tool-order', sequence: ['readPage', 'querySelector'], strict: true }]),
      trace([call('1', 'readPage'), result('1', true), call('2', 'fetchGet'), result('2', true), call('3', 'querySelector'), result('3', true)]))
    expect(r.callRate).toBe(0)
  })

  it('max-redundant-calls counts duplicates by (name + args)', () => {
    const r = runTraceJudges(T([{ kind: 'max-redundant-calls', name: 'readPage', max: 1 }]),
      trace([call('1', 'readPage'), result('1', true), call('2', 'readPage'), result('2', true)]))
    expect(r.redundancy).toBe(1)
    expect(r.redundancyMax).toBeGreaterThanOrEqual(1)
  })

  it('recovery: detects after-failure tool change → recoveryScore 1', () => {
    const r = runTraceJudges(T([]),
      trace([call('1', 'fetchGet', { url: 'a' }), result('1', false),
             call('2', 'readPage'), result('2', true)]))
    expect(r.hadFailure).toBe(true)
    expect(r.recoveryScore).toBe(1)
  })

  it('recovery: same call retried → recoveryScore 0', () => {
    const r = runTraceJudges(T([]),
      trace([call('1', 'fetchGet', { url: 'a' }), result('1', false),
             call('2', 'fetchGet', { url: 'a' }), result('2', false)]))
    expect(r.hadFailure).toBe(true)
    expect(r.recoveryScore).toBe(0)
  })

  it('recovery: failure with no follow-up call → recoveryScore 0.5', () => {
    const r = runTraceJudges(T([]),
      trace([call('1', 'fetchGet', { url: 'a' }), result('1', false)]))
    expect(r.hadFailure).toBe(true)
    expect(r.recoveryScore).toBe(0.5)
  })
})
