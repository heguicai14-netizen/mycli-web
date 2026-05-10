import { describe, it, expect } from 'vitest'
import { renderJson } from '../../../../eval/core/reporter/json'
import type { SuiteReport } from '../../../../eval/core/types'

const sample: SuiteReport = {
  schemaVersion: 1,
  startedAt: '2026-05-10T14:32:00Z',
  llmModel: 'glm-4.6',
  totals: { passed: 1, failed: 0, skipped: 0 },
  byLevel: { L1: { passed: 1, failed: 0, meanComposite: 0.9 },
             L2: { passed: 0, failed: 0, meanComposite: 0 },
             L3: { passed: 0, failed: 0, meanComposite: 0 } },
  byTag: {},
  meanComposite: 0.9, meanTokens: 100, meanSteps: 1,
  tasks: [],
}

describe('renderJson', () => {
  it('round-trips through JSON.parse with schemaVersion=1', () => {
    const out = renderJson(sample)
    const parsed = JSON.parse(out)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.llmModel).toBe('glm-4.6')
    expect(parsed.totals.passed).toBe(1)
  })

  it('is deterministic key order (sorted)', () => {
    const a = renderJson(sample)
    const b = renderJson(sample)
    expect(a).toBe(b)
  })
})
