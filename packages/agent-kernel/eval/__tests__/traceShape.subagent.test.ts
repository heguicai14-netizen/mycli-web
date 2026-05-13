import { describe, it, expect } from 'vitest'
import { runTraceJudges } from '../judges/trace-shape'
import type { Task, RunTrace } from '../core/types'

function makeTrace(steps: any[]): RunTrace {
  return { taskId: 't', steps, finalAnswer: '', tokensIn: 0, tokensOut: 0, durationMs: 0 }
}

function task(asserts: any[]): Task {
  return {
    id: 'x', level: 'L4', prompt: '', fixtures: {},
    budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
    judge: { trace: asserts },
  }
}

const spawn = (overrides: Partial<any> = {}) => ({
  kind: 'subagent-spawn',
  subagentId: 's',
  type: 'general-purpose',
  prompt: 'p',
  description: 'd',
  parentCallId: 'c',
  ok: true,
  finalText: 'r',
  iterations: 2,
  ...overrides,
})

describe('subagent-* assertions', () => {
  it('subagent-spawned passes when ≥1 spawn exists', () => {
    const r = runTraceJudges(task([{ kind: 'subagent-spawned' }]), makeTrace([spawn()]))
    expect(r.callRate).toBe(1)
  })

  it('subagent-spawned fails when no spawn', () => {
    const r = runTraceJudges(task([{ kind: 'subagent-spawned' }]), makeTrace([]))
    expect(r.callRate).toBe(0)
  })

  it('subagent-spawned minCount enforces count', () => {
    const r = runTraceJudges(
      task([{ kind: 'subagent-spawned', minCount: 2 }]),
      makeTrace([spawn({ subagentId: 'a' })]),
    )
    expect(r.callRate).toBe(0)
  })

  it('subagent-spawned with type filters by type', () => {
    const t = makeTrace([spawn({ type: 'explore' })])
    expect(runTraceJudges(task([{ kind: 'subagent-spawned', type: 'general-purpose' }]), t).callRate).toBe(0)
    expect(runTraceJudges(task([{ kind: 'subagent-spawned', type: 'explore' }]), t).callRate).toBe(1)
  })

  it('subagent-spawned maxCount cap', () => {
    const trace = makeTrace([spawn({ subagentId: 'a' }), spawn({ subagentId: 'b' }), spawn({ subagentId: 'c' })])
    expect(runTraceJudges(task([{ kind: 'subagent-spawned', maxCount: 2 }]), trace).callRate).toBe(0)
    expect(runTraceJudges(task([{ kind: 'subagent-spawned', maxCount: 5 }]), trace).callRate).toBe(1)
  })

  it('subagent-not-spawned passes only when zero spawns', () => {
    expect(runTraceJudges(task([{ kind: 'subagent-not-spawned' }]), makeTrace([])).callRate).toBe(1)
    expect(runTraceJudges(task([{ kind: 'subagent-not-spawned' }]), makeTrace([spawn()])).callRate).toBe(0)
  })

  it('subagent-parallel counts Task tool_calls within same batch', () => {
    const t = makeTrace([
      { kind: 'tool-call', name: 'Task', args: {}, id: 'c1', batchId: 'b1' },
      { kind: 'tool-call', name: 'Task', args: {}, id: 'c2', batchId: 'b1' },
      { kind: 'tool-call', name: 'Task', args: {}, id: 'c3', batchId: 'b2' },
    ])
    expect(runTraceJudges(task([{ kind: 'subagent-parallel', minCount: 2 }]), t).callRate).toBe(1)
    expect(runTraceJudges(task([{ kind: 'subagent-parallel', minCount: 3 }]), t).callRate).toBe(0)
  })

  it('subagent-parallel ignores non-Task batches', () => {
    const t = makeTrace([
      { kind: 'tool-call', name: 'foo', args: {}, id: 'c1', batchId: 'b1' },
      { kind: 'tool-call', name: 'bar', args: {}, id: 'c2', batchId: 'b1' },
    ])
    expect(runTraceJudges(task([{ kind: 'subagent-parallel', minCount: 2 }]), t).callRate).toBe(0)
  })

  it('subagent-final-ok counts ok=true spawns', () => {
    const t = makeTrace([
      spawn({ subagentId: 'a', ok: true }),
      spawn({ subagentId: 'b', ok: false }),
      spawn({ subagentId: 'c', ok: true }),
    ])
    expect(runTraceJudges(task([{ kind: 'subagent-final-ok', minCount: 2 }]), t).callRate).toBe(1)
    expect(runTraceJudges(task([{ kind: 'subagent-final-ok', minCount: 3 }]), t).callRate).toBe(0)
  })
})

describe('todo-* assertions', () => {
  const todoCall = (items: any[]) => ({
    kind: 'tool-call',
    name: 'todoWrite',
    args: { items },
    id: 't1',
  })

  it('todo-written passes when items length ≥ minItems', () => {
    const t = makeTrace([todoCall([{ subject: 'a', status: 'pending' }, { subject: 'b', status: 'pending' }])])
    expect(runTraceJudges(task([{ kind: 'todo-written', minItems: 2 }]), t).callRate).toBe(1)
    expect(runTraceJudges(task([{ kind: 'todo-written', minItems: 3 }]), t).callRate).toBe(0)
  })

  it('todo-written fails when no todoWrite call', () => {
    expect(runTraceJudges(task([{ kind: 'todo-written' }]), makeTrace([])).callRate).toBe(0)
  })

  it('todo-final-status: allCompleted passes only when last call has all completed', () => {
    const tPass = makeTrace([
      todoCall([{ subject: 'a', status: 'in_progress' }]),
      todoCall([{ subject: 'a', status: 'completed' }]),
    ])
    expect(runTraceJudges(task([{ kind: 'todo-final-status', allCompleted: true }]), tPass).callRate).toBe(1)

    const tFail = makeTrace([
      todoCall([{ subject: 'a', status: 'completed' }, { subject: 'b', status: 'pending' }]),
    ])
    expect(runTraceJudges(task([{ kind: 'todo-final-status', allCompleted: true }]), tFail).callRate).toBe(0)
  })
})
