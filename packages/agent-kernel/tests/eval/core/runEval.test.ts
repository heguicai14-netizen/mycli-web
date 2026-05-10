import { describe, it, expect } from 'vitest'
import { runEvalCore } from '../../../eval/core/runEval'
import type { Task } from '../../../eval/core/types'

const tasks: Task[] = [
  {
    id: 'L1/a', level: 'L1', prompt: '', fixtures: {},
    judge: { completion: [{ kind: 'answer-contains', value: 'hi' }] },
    budget: { expectedSteps: 1, expectedTokens: 100, expectedDurMs: 1000, maxSteps: 3 },
    tags: ['t1'],
  },
  {
    id: 'L2/b', level: 'L2', prompt: '', fixtures: {},
    judge: { completion: [{ kind: 'answer-contains', value: 'bye' }] },
    budget: { expectedSteps: 1, expectedTokens: 100, expectedDurMs: 1000, maxSteps: 3 },
    tags: ['t1', 'data-analysis'],
  },
]

const llmStub = {
  async *streamChat() {
    yield { kind: 'delta', text: 'hi' }; yield { kind: 'done', stopReason: 'stop' }
  },
} as any

describe('runEvalCore', () => {
  it('aggregates totals + byLevel + byTag', async () => {
    const r = await runEvalCore({
      tasks, llm: llmStub, judgeLLM: undefined,
      buildTools: () => [],
    })
    expect(r.totals.passed).toBe(1)
    expect(r.totals.failed).toBe(1)
    expect(r.byLevel.L1.passed).toBe(1)
    expect(r.byLevel.L2.failed).toBe(1)
    expect(r.byTag['t1'].passed + r.byTag['t1'].failed).toBe(2)
    expect(r.byTag['data-analysis'].failed).toBe(1)
    expect(r.tasks).toHaveLength(2)
    expect(r.schemaVersion).toBe(1)
  })

  it('wrapLlmForTask is called per task with the right id', async () => {
    const seen: string[] = []
    await runEvalCore({
      tasks, llm: llmStub, judgeLLM: undefined,
      buildTools: () => [],
      wrapLlmForTask: (id, l) => { seen.push(id); return l },
    })
    expect(seen).toEqual(['L1/a', 'L2/b'])
  })
})
