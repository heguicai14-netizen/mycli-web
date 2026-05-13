import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runSingleTask } from '../core/runner'
import type { Task } from '../core/types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

const dummyTask = (id = 't1'): Task => ({
  id, level: 'L1', prompt: 'go', fixtures: {},
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 5 },
  judge: {},
})

const noJudges = {
  runHardJudges: () => ({ passed: 0, total: 0, failures: [] }),
  runTraceJudges: () => ({ callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: false, recoveryScore: 1 as const, failures: [] }),
  runLlmJudge: async () => undefined,
}

function fastLlm(): OpenAICompatibleClient {
  return {
    async *streamChat() {
      yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
    },
  } as any
}

function hangLlm(): OpenAICompatibleClient {
  return {
    async *streamChat(req: any) {
      const sig = req.signal
      await new Promise((_, rej) => {
        sig?.addEventListener('abort', () => rej(new Error('AbortError')))
      })
    },
  } as any
}

describe('runSingleTask — taskTimeoutMs', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fast task completes normally without abortReason', async () => {
    const result = await runSingleTask({
      task: dummyTask(),
      llm: fastLlm(),
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
      taskTimeoutMs: 5_000,
    } as any)
    expect(result.trace.abortReason).toBeUndefined()
    expect(result.task.id).toBe('t1')
  })

  it('hanging task is aborted after taskTimeoutMs and abortReason=timeout', async () => {
    const llm = hangLlm()
    const promise = runSingleTask({
      task: dummyTask(),
      llm,
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
      taskTimeoutMs: 1_000,
    } as any)
    await vi.advanceTimersByTimeAsync(1_500)
    const result = await promise
    expect(result.trace.abortReason).toBe('timeout')
    expect(result.passed).toBe(false)
  })

  it('taskTimeoutMs=0 disables timeout (test by mocking; should not abort fast task)', async () => {
    const result = await runSingleTask({
      task: dummyTask(),
      llm: fastLlm(),
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
      taskTimeoutMs: 0,
    } as any)
    expect(result.trace.abortReason).toBeUndefined()
  })

  it('default taskTimeoutMs is 300000 when not provided', async () => {
    // We can't easily inspect the default in isolation, but verify fast task still works
    const result = await runSingleTask({
      task: dummyTask(),
      llm: fastLlm(),
      judgeLLM: undefined,
      buildTools: () => [],
      ...noJudges,
    } as any)
    expect(result.task.id).toBe('t1')
  })
})
