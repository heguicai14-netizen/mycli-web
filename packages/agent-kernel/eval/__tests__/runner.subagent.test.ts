import { describe, it, expect } from 'vitest'
import { runSingleTask } from '../core/runner'
import type { Task } from '../core/types'
import type { ToolDefinition } from '../../src/core/types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import type { SubagentType } from '../../src/core/subagent'

function llmYields(...steps: Array<() => any>): OpenAICompatibleClient {
  let i = 0
  return {
    async *streamChat() {
      const fn = steps[i++]
      if (!fn) throw new Error('script exhausted')
      yield* fn()
    },
  } as any
}

const dummyTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't', level: 'L4', prompt: 'go', fixtures: {},
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 3 },
  judge: {},
  ...overrides,
})

const noJudges = {
  runHardJudges: () => ({ passed: 0, total: 0, failures: [] }),
  runTraceJudges: () => ({ callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: false, recoveryScore: 1 as const, failures: [] }),
  runLlmJudge: async () => undefined,
}

describe('runSingleTask — subagent + todo wiring', () => {
  it('omitted subagentTypes → does not throw', async () => {
    const probe: ToolDefinition = {
      name: 'probe', description: '', inputSchema: {},
      async execute() { return { ok: true, data: 'r' } },
    }
    const llm = llmYields(() => (async function* () {
      yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
    })())
    const result = await runSingleTask({
      task: dummyTask(),
      llm,
      judgeLLM: undefined,
      buildTools: () => [probe],
      ...noJudges,
    })
    expect(result.task.id).toBe('t')
  })

  it('with subagentTypes → completes without crashing', async () => {
    const gp: SubagentType = {
      name: 'general-purpose', description: 'gp', systemPrompt: 's',
      allowedTools: '*', maxIterations: 3,
    }
    const llm = llmYields(() => (async function* () {
      yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
    })())
    const result = await runSingleTask({
      task: dummyTask(),
      llm,
      judgeLLM: undefined,
      buildTools: () => [],
      subagentTypes: [gp],
      ...noJudges,
    })
    expect(result.task.id).toBe('t')
  })

  it('task with tag "todo" auto-injects todoStore + completes', async () => {
    let observedCtx: any = null
    const probe: ToolDefinition = {
      name: 'probe', description: '', inputSchema: {},
      async execute(_input, ctx) { observedCtx = ctx; return { ok: true, data: 'r' } },
    }
    const llm = llmYields(
      () => (async function* () {
        yield {
          kind: 'done', stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'probe', input: {} }],
        }
      })(),
      () => (async function* () {
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      })(),
    )
    await runSingleTask({
      task: dummyTask({ tags: ['todo'] }),
      llm,
      judgeLLM: undefined,
      buildTools: () => [probe],
      ...noJudges,
    })
    expect(observedCtx).not.toBeNull()
    expect(observedCtx.todoStore).toBeDefined()
    expect(observedCtx.conversationId).toBeDefined()
    expect(observedCtx.turnId).toBeDefined()
    expect(observedCtx.callId).toBe('c1')
    expect(typeof observedCtx.emitSubagentEvent).toBe('function')
  })

  it('task without "todo" tag does NOT auto-inject todoStore', async () => {
    let observedCtx: any = null
    const probe: ToolDefinition = {
      name: 'probe', description: '', inputSchema: {},
      async execute(_input, ctx) { observedCtx = ctx; return { ok: true, data: 'r' } },
    }
    const llm = llmYields(
      () => (async function* () {
        yield { kind: 'done', stopReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'probe', input: {} }] }
      })(),
      () => (async function* () {
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      })(),
    )
    await runSingleTask({
      task: dummyTask({ tags: ['multi-step'] }),
      llm,
      judgeLLM: undefined,
      buildTools: () => [probe],
      ...noJudges,
    })
    expect(observedCtx.todoStore).toBeUndefined()
  })
})
