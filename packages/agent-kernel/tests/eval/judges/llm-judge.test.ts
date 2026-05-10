import { describe, it, expect } from 'vitest'
import { runLlmJudge } from '../../../eval/judges/llm-judge'
import type { Task, RunTrace } from '../../../eval/core/types'

const trace: RunTrace = {
  taskId: 't', steps: [], finalAnswer: 'OK', tokensIn: 0, tokensOut: 0, durationMs: 0,
}
const tWith = (rubric: any): Task => ({
  id: 't', level: 'L1', prompt: 'q', fixtures: {}, judge: { llm: rubric },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
})
function fakeLlm(text: string) {
  return {
    async *streamChat() {
      yield { kind: 'delta', text }
      yield { kind: 'done', stopReason: 'stop' }
    },
  } as any
}

describe('runLlmJudge', () => {
  it('returns undefined when no rubric', async () => {
    const t: Task = { ...tWith({ question: '', scale: '0-5' }), judge: {} }
    expect(await runLlmJudge(t, trace, fakeLlm('{"score":3}'))).toBeUndefined()
  })
  it('returns undefined when no judge LLM provided', async () => {
    expect(await runLlmJudge(tWith({ question: 'ok?', scale: '0-5' }), trace, undefined)).toBeUndefined()
  })
  it('parses 0-5 scale and normalizes to 0..1', async () => {
    const r = await runLlmJudge(tWith({ question: 'ok?', scale: '0-5' }), trace, fakeLlm('{"score":4,"reason":"good"}'))
    expect(r).toBeCloseTo(0.8)
  })
  it('parses pass-fail scale (score 0 or 5)', async () => {
    const r = await runLlmJudge(tWith({ question: 'ok?', scale: 'pass-fail' }), trace, fakeLlm('{"score":5,"reason":"yes"}'))
    expect(r).toBeCloseTo(1)
  })
  it('returns undefined on unparsable response', async () => {
    expect(await runLlmJudge(tWith({ question: 'ok?', scale: '0-5' }), trace, fakeLlm('not json at all'))).toBeUndefined()
  })
})
