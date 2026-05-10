import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../../../eval/core/reporter/markdown'
import type { SuiteReport } from '../../../../eval/core/types'

const sample: SuiteReport = {
  schemaVersion: 1,
  startedAt: '2026-05-10T14:32:00Z',
  llmModel: 'glm-4.6',
  totals: { passed: 1, failed: 1, skipped: 0 },
  byLevel: { L1: { passed: 1, failed: 0, meanComposite: 1 },
             L2: { passed: 0, failed: 1, meanComposite: 0.4 },
             L3: { passed: 0, failed: 0, meanComposite: 0 } },
  byTag: {},
  meanComposite: 0.7, meanTokens: 1000, meanSteps: 3,
  tasks: [
    {
      task: { id: 'L2/issue-summary', level: 'L2', prompt: 'summarize', tags: [] } as any,
      trace: {
        taskId: 'L2/issue-summary',
        steps: [
          { kind: 'assistant-message', text: 'I will read the page' },
          { kind: 'tool-call', id: 'c1', name: 'readPage', args: {} },
          { kind: 'tool-result', id: 'c1', ok: true, data: 'page text' },
        ],
        finalAnswer: 'short answer',
        tokensIn: 500, tokensOut: 50, durationMs: 3200,
      },
      scores: { completion: 0.4, traceQuality: 0.5, efficiency: 0.4, composite: 0.43 },
      passed: false,
      failures: ['answer-contains("#1234"): actual="short answer"'],
    },
  ],
}

describe('renderMarkdown', () => {
  it('starts with H1 and includes summary table', () => {
    const out = renderMarkdown(sample)
    expect(out).toMatch(/^# agent-kernel eval/m)
    expect(out).toMatch(/glm-4\.6/)
    expect(out).toMatch(/\| L1 \|/)
  })
  it('per-task section shows prompt, scores, failures, trace', () => {
    const out = renderMarkdown(sample)
    expect(out).toMatch(/## L2\/issue-summary/)
    expect(out).toMatch(/composite.*0\.43/)
    expect(out).toMatch(/answer-contains.*#1234/)
    expect(out).toMatch(/readPage/)
  })
})
