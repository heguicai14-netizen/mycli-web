import { describe, it, expect } from 'vitest'
import { runSingleTask } from '../../../eval/core/runner'
import type { Task } from '../../../eval/core/types'

const echoTask: Task = {
  id: 'L1/echo',
  level: 'L1',
  prompt: 'say hi',
  fixtures: {},
  budget: { expectedSteps: 1, expectedTokens: 100, expectedDurMs: 1000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: 'hi' }],
  },
  tags: ['smoke'],
}

describe('runSingleTask', () => {
  it('runs a task end-to-end and returns a TaskReport', async () => {
    // Mock LLM: emit a single assistant message "hi" with no tool calls.
    const llmStub = {
      async *streamChat() {
        yield { kind: 'delta', text: 'hi' }
        yield { kind: 'done', stopReason: 'stop', usage: { in: 5, out: 1 } }
      },
    } as any

    const report = await runSingleTask({
      task: echoTask,
      llm: llmStub,
      judgeLLM: undefined,
      buildTools: () => [],
      runHardJudges: (_t, trace) => ({
        passed: trace.finalAnswer.includes('hi') ? 1 : 0,
        total: 1,
        failures: [],
      }),
      runTraceJudges: () => ({
        callRate: 1, redundancy: 0, redundancyMax: 1,
        hadFailure: false, recovered: false,
        failures: [],
      }),
      runLlmJudge: async () => undefined,
    })
    expect(report.passed).toBe(true)
    expect(report.scores.composite).toBeGreaterThan(0.5)
    expect(report.trace.finalAnswer).toBe('hi')
  })

  it('reports passed=false when answer fails the assertion', async () => {
    const llmStub = {
      async *streamChat() {
        yield { kind: 'delta', text: 'bye' }
        yield { kind: 'done', stopReason: 'stop' }
      },
    } as any
    const report = await runSingleTask({
      task: echoTask,
      llm: llmStub,
      judgeLLM: undefined,
      buildTools: () => [],
      runHardJudges: (_t, trace) => ({
        passed: trace.finalAnswer.includes('hi') ? 1 : 0,
        total: 1,
        failures: trace.finalAnswer.includes('hi') ? [] : ['answer-contains("hi"): actual="bye"'],
      }),
      runTraceJudges: () => ({
        callRate: 1, redundancy: 0, redundancyMax: 1,
        hadFailure: false, recovered: false,
        failures: [],
      }),
      runLlmJudge: async () => undefined,
    })
    expect(report.passed).toBe(false)
    expect(report.failures).toContain('answer-contains("hi"): actual="bye"')
  })
})
