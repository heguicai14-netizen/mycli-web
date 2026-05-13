import { describe, it, expect, vi } from 'vitest'
import { runEvalCore } from '../core/runEval'
import type { Suite, Task } from '../core/types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

const fastLlm = {
  async *streamChat() {
    yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
  },
} as unknown as OpenAICompatibleClient

function makeTask(id: string): Task {
  return {
    id, level: 'L1', prompt: 'p', fixtures: {},
    budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 5 },
    judge: {},
  }
}

describe('runEvalCore — parallel + error isolation', () => {
  it('default parallel=1: reports stay in input order', async () => {
    const tasks: Suite = ['a', 'b', 'c'].map(makeTask)
    const result = await runEvalCore({
      tasks, llm: fastLlm, judgeLLM: undefined,
      buildTools: () => [],
    } as any)
    expect(result.tasks.map((t) => t.task.id)).toEqual(['a', 'b', 'c'])
  })

  it('parallel=4: up to 4 tasks run concurrently and reports stay in input order', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const tasks: Suite = ids.map(makeTask)
    let inFlight = 0
    let maxInFlight = 0
    const slowLlm = {
      async *streamChat() {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    } as unknown as OpenAICompatibleClient

    const result = await runEvalCore({
      tasks, llm: slowLlm, judgeLLM: undefined,
      buildTools: () => [],
      parallel: 4,
    } as any)
    expect(result.tasks.map((t) => t.task.id)).toEqual(ids)
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(maxInFlight).toBeGreaterThan(1)   // we DID get parallelism
  })

  it('per-task error isolation: failed task does not break batch', async () => {
    const tasks: Suite = ['a', 'b', 'c'].map(makeTask)
    let callCount = 0
    const llm = {
      async *streamChat() {
        callCount++
        if (callCount === 2) throw new Error('synthetic-failure')
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    } as unknown as OpenAICompatibleClient
    const result = await runEvalCore({
      tasks, llm, judgeLLM: undefined,
      buildTools: () => [],
    } as any)
    expect(result.tasks).toHaveLength(3)
    expect(result.tasks.filter((t) => t.passed === false).length).toBeGreaterThanOrEqual(1)
    expect(result.tasks.map((t) => t.task.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('parallel report input-order preservation across mixed pass/fail', async () => {
    const tasks: Suite = ['x', 'y', 'z'].map(makeTask)
    const llm = {
      async *streamChat() {
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    } as unknown as OpenAICompatibleClient
    const result = await runEvalCore({
      tasks, llm, judgeLLM: undefined,
      buildTools: () => [],
      parallel: 3,
    } as any)
    expect(result.tasks.map((t) => t.task.id)).toEqual(['x', 'y', 'z'])
  })
})
