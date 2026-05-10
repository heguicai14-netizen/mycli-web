import { describe, it, expect } from 'vitest'
import {
  scoreCompletion,
  scoreTraceQuality,
  scoreEfficiency,
  composite,
  passed,
  passThresholdFor,
} from '../../../eval/core/scorer'

describe('passThresholdFor', () => {
  it('L1=0.7, L2=0.6, L3=0.5', () => {
    expect(passThresholdFor('L1')).toBeCloseTo(0.7)
    expect(passThresholdFor('L2')).toBeCloseTo(0.6)
    expect(passThresholdFor('L3')).toBeCloseTo(0.5)
  })
})

describe('scoreCompletion', () => {
  it('pure hard assertions: ratio of passed', () => {
    expect(scoreCompletion({ hardPassed: 2, hardTotal: 3, llmScore: undefined, llmWeight: 0 }))
      .toBeCloseTo(2 / 3)
  })

  it('no assertions at all → 1.0', () => {
    expect(scoreCompletion({ hardPassed: 0, hardTotal: 0, llmScore: undefined, llmWeight: 0 }))
      .toBeCloseTo(1.0)
  })

  it('hard + LLM with weight=1 (default) → λ=0.30', () => {
    // hard 1.0, llm 0.0 → 1.0 * 0.7 + 0.0 * 0.3 = 0.7
    expect(scoreCompletion({ hardPassed: 2, hardTotal: 2, llmScore: 0, llmWeight: 1 }))
      .toBeCloseTo(0.7)
  })

  it('hard + LLM with weight=2 → λ=0.60', () => {
    // hard 0.5, llm 1.0 → 0.5 * 0.4 + 1.0 * 0.6 = 0.8
    expect(scoreCompletion({ hardPassed: 1, hardTotal: 2, llmScore: 1, llmWeight: 2 }))
      .toBeCloseTo(0.8)
  })

  it('clamps λ at 1.0 for huge weight', () => {
    // hard 0, llm 1.0, λ=1 → 1.0
    expect(scoreCompletion({ hardPassed: 0, hardTotal: 1, llmScore: 1, llmWeight: 100 }))
      .toBeCloseTo(1.0)
  })
})

describe('scoreTraceQuality', () => {
  it('all sub-scores 1 → 1.0', () => {
    expect(
      scoreTraceQuality({
        callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: false, recovered: false,
      }),
    ).toBeCloseTo(1.0)
  })

  it('weights: 0.6 calls + 0.2 redundancy + 0.2 recovery', () => {
    // calls 0.5, redundancy 1/2 → noRedundancy = 0.5, no failure → recovery 1
    // = 0.5*0.6 + 0.5*0.2 + 1*0.2 = 0.3 + 0.1 + 0.2 = 0.6
    expect(
      scoreTraceQuality({
        callRate: 0.5, redundancy: 1, redundancyMax: 2, hadFailure: false, recovered: false,
      }),
    ).toBeCloseTo(0.6)
  })

  it('failure not recovered → recovery 0', () => {
    // calls 1, no redundancy, hadFailure & not recovered → 0
    // = 1*0.6 + 1*0.2 + 0*0.2 = 0.8
    expect(
      scoreTraceQuality({
        callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: true, recovered: false,
      }),
    ).toBeCloseTo(0.8)
  })

  it('failure recovered → recovery 1', () => {
    expect(
      scoreTraceQuality({
        callRate: 1, redundancy: 0, redundancyMax: 1, hadFailure: true, recovered: true,
      }),
    ).toBeCloseTo(1.0)
  })
})

describe('scoreEfficiency', () => {
  it('all under budget → 1.0', () => {
    expect(
      scoreEfficiency(
        { steps: 3, tokens: 1000, durMs: 5000 },
        { expectedSteps: 5, expectedTokens: 4000, expectedDurMs: 8000, maxSteps: 8 },
      ),
    ).toBeCloseTo(1.0)
  })

  it('steps over budget linearly degrades', () => {
    // steps 10, expected 5 → stepScore = clamp(1 - (10-5)/5) = 0
    // tokens 0, dur 0 → 1, 1
    // = 0*0.5 + 1*0.4 + 1*0.1 = 0.5
    expect(
      scoreEfficiency(
        { steps: 10, tokens: 0, durMs: 0 },
        { expectedSteps: 5, expectedTokens: 4000, expectedDurMs: 8000, maxSteps: 20 },
      ),
    ).toBeCloseTo(0.5)
  })
})

describe('composite + passed', () => {
  it('composite = 0.55 completion + 0.30 trace + 0.15 efficiency', () => {
    expect(composite(1.0, 1.0, 1.0)).toBeCloseTo(1.0)
    expect(composite(0.5, 0.5, 0.5)).toBeCloseTo(0.5)
    expect(composite(1.0, 0.0, 0.0)).toBeCloseTo(0.55)
  })

  it('passed: composite ≥ threshold AND completion ≥ 0.5', () => {
    expect(passed(0.7, 0.6, 0.6)).toBe(true)        // L2 default: 0.6 threshold
    expect(passed(0.4, 0.6, 0.6)).toBe(false)       // completion < 0.5 hard cut
    expect(passed(0.8, 0.55, 0.6)).toBe(false)      // composite < threshold
  })
})
