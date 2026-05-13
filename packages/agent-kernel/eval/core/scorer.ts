import type { TaskBudget, TaskLevel } from './types'

const W_COMPLETION = 0.55
const W_TRACE      = 0.30
const W_EFFICIENCY = 0.15

const W_TRACE_CALLS    = 0.6
const W_TRACE_NO_REDUN = 0.2
const W_TRACE_RECOVERY = 0.2

const W_EFF_STEPS  = 0.5
const W_EFF_TOKENS = 0.4
const W_EFF_DUR    = 0.1

const LAMBDA_LLM_BASE = 0.3

export function passThresholdFor(level: TaskLevel): number {
  return level === 'L1' ? 0.7
       : level === 'L2' ? 0.6
       : level === 'L3' ? 0.5
       : 0.45
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

export interface CompletionInput {
  hardPassed: number
  hardTotal: number
  llmScore: number | undefined  // 0..1
  llmWeight: number             // LlmRubric.weight, 0 if no rubric
}
export function scoreCompletion(i: CompletionInput): number {
  const hardScore = i.hardTotal === 0 ? 1.0 : i.hardPassed / i.hardTotal
  if (i.llmScore === undefined) return hardScore
  const lambda = clamp01(LAMBDA_LLM_BASE * i.llmWeight)
  return clamp01(hardScore * (1 - lambda) + i.llmScore * lambda)
}

export interface TraceQualityInput {
  callRate: number             // tool-called/not-called/order hit ratio
  redundancy: number
  redundancyMax: number        // sum of max-redundant-calls limits across asserts; default 1
  hadFailure: boolean
  recoveryScore: 0 | 0.5 | 1  // ignored when !hadFailure (treated as 1)
}
export function scoreTraceQuality(i: TraceQualityInput): number {
  const noRedun = clamp01(1 - i.redundancy / Math.max(1, i.redundancyMax))
  const recovery = !i.hadFailure ? 1 : i.recoveryScore
  return clamp01(
    i.callRate * W_TRACE_CALLS +
    noRedun    * W_TRACE_NO_REDUN +
    recovery   * W_TRACE_RECOVERY,
  )
}

export interface EfficiencyActuals {
  steps: number
  tokens: number
  durMs: number
}
export function scoreEfficiency(a: EfficiencyActuals, b: TaskBudget): number {
  const stepScore    = clamp01(1 - (a.steps  - b.expectedSteps)  / Math.max(1, b.expectedSteps))
  const tokenScore   = clamp01(1 - (a.tokens - b.expectedTokens) / Math.max(1, b.expectedTokens))
  const latencyScore = clamp01(1 - (a.durMs  - b.expectedDurMs)  / Math.max(1, b.expectedDurMs))
  return clamp01(
    stepScore    * W_EFF_STEPS +
    tokenScore   * W_EFF_TOKENS +
    latencyScore * W_EFF_DUR,
  )
}

export function composite(c: number, t: number, e: number): number {
  return clamp01(c * W_COMPLETION + t * W_TRACE + e * W_EFFICIENCY)
}

/**
 * A task passes when its composite score clears the level threshold AND its
 * completion score is at least 0.5 (the hard cutoff per spec §3.1 — even a
 * great trace + perfect efficiency cannot make up for a wrong answer).
 */
export function passed(completionScore: number, compositeScore: number, threshold: number): boolean {
  return compositeScore >= threshold && completionScore >= 0.5
}
