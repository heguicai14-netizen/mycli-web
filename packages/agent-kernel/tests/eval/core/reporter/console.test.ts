import { describe, it, expect } from 'vitest'
import { renderConsole } from '../../../../eval/core/reporter/console'
import type { SuiteReport } from '../../../../eval/core/types'

const sample: SuiteReport = {
  schemaVersion: 1,
  startedAt: '2026-05-10T14:32:00Z',
  llmModel: 'glm-4.6',
  totals: { passed: 13, failed: 5, skipped: 0 },
  byLevel: {
    L1: { passed: 6, failed: 0, meanComposite: 0.91 },
    L2: { passed: 6, failed: 2, meanComposite: 0.71 },
    L3: { passed: 1, failed: 3, meanComposite: 0.48 },
  },
  byTag: {
    'data-analysis': { passed: 2, failed: 1, meanComposite: 0.61 },
  },
  meanComposite: 0.74,
  meanTokens: 10000,
  meanSteps: 5,
  tasks: [
    {
      task: { id: 'L2/exp-cross-validate' } as any,
      trace: { steps: [], finalAnswer: '', tokensIn: 0, tokensOut: 0, durationMs: 0 } as any,
      scores: { completion: 0.5, traceQuality: 0.5, efficiency: 0.5, composite: 0.51 },
      passed: false,
      failures: [],
    },
  ],
}

describe('renderConsole', () => {
  it('includes model and totals', () => {
    const out = renderConsole(sample)
    expect(out).toMatch(/model=glm-4\.6/)
    expect(out).toMatch(/18 tasks/)
    expect(out).toMatch(/L1\s+.+6\/6/)
    expect(out).toMatch(/L2\s+.+6\/8/)
    expect(out).toMatch(/L3\s+.+1\/4/)
    expect(out).toMatch(/TOTAL\s+13\/18/)
    expect(out).toMatch(/data-analysis\s+2\/3/)
  })
  it('lists failed task ids', () => {
    expect(renderConsole(sample)).toMatch(/L2\/exp-cross-validate.*0\.51/)
  })
})
