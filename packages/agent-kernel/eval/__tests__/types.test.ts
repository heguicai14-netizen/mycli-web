import { describe, it, expect } from 'vitest'
import type {
  TaskLevel,
  TraceStep,
  TraceAssertion,
  HardAssertion,
} from '../core/types'

describe('eval types — L4 / subagent / todo extensions', () => {
  it('TaskLevel accepts L4', () => {
    const lvl: TaskLevel = 'L4'
    expect(lvl).toBe('L4')
  })

  it('TraceStep accepts subagent-spawn kind', () => {
    const step: TraceStep = {
      kind: 'subagent-spawn',
      subagentId: 'sid-1',
      type: 'general-purpose',
      prompt: 'p',
      description: 'd',
      parentCallId: 'cc-1',
      ok: true,
      finalText: 'ans',
      iterations: 2,
    }
    expect(step.kind).toBe('subagent-spawn')
  })

  it('TraceStep tool-call accepts optional batchId', () => {
    const step: TraceStep = {
      kind: 'tool-call',
      name: 't',
      args: {},
      id: 'id',
      batchId: 'batch-1',
    }
    expect((step as any).batchId).toBe('batch-1')
  })

  it('TraceAssertion accepts 6 new variants', () => {
    const a: TraceAssertion[] = [
      { kind: 'subagent-spawned' },
      { kind: 'subagent-spawned', type: 'explore', minCount: 2, maxCount: 5 },
      { kind: 'subagent-not-spawned' },
      { kind: 'subagent-parallel', minCount: 2 },
      { kind: 'subagent-final-ok' },
      { kind: 'subagent-final-ok', minCount: 3 },
      { kind: 'todo-written' },
      { kind: 'todo-written', minItems: 3 },
      { kind: 'todo-final-status', allCompleted: true },
    ]
    expect(a).toHaveLength(9)
  })

  it('HardAssertion accepts answer-not-contains', () => {
    const a: HardAssertion = { kind: 'answer-not-contains', value: /hacked/ }
    expect(a.kind).toBe('answer-not-contains')
  })
})
