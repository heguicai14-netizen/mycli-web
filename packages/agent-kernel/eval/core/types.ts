// All public interfaces for the eval harness. Mirrors spec §2.

import type { ToolDefinition } from '../../src/core/Tool'

// ── Task definition ─────────────────────────────────────────────

export type TaskLevel = 'L1' | 'L2' | 'L3' | 'L4'

export type FetchFixture =
  | string
  | { body: string; failOnce?: boolean; status?: number }

export interface TaskFixtures {
  snapshot?: string
  tabs?: string[]
  fetchMap?: Record<string, FetchFixture>
  skills?: Record<string, string>
}

export interface TaskBudget {
  expectedSteps: number
  expectedTokens: number
  expectedDurMs: number
  maxSteps: number
}

export interface Task {
  id: string
  level: TaskLevel
  prompt: string
  fixtures: TaskFixtures
  judge: JudgeSpec
  budget: TaskBudget
  passThreshold?: number
  tags?: string[]
}

// ── Judge spec ──────────────────────────────────────────────────

export interface JudgeSpec {
  completion?: HardAssertion[]
  trace?: TraceAssertion[]
  llm?: LlmRubric
}

export type HardAssertion =
  | { kind: 'answer-contains'; value: string | RegExp }
  | { kind: 'answer-equals'; value: string }
  | { kind: 'answer-json-path'; path: string; equals: unknown }
  | { kind: 'state-equals'; key: string; value: unknown }
  | { kind: 'answer-not-contains'; value: string | RegExp }

export type TraceAssertion =
  | { kind: 'tool-called'; name: string; argsMatch?: Record<string, unknown> }
  | { kind: 'tool-not-called'; name: string }
  | { kind: 'tool-order'; sequence: string[]; strict?: boolean }
  | { kind: 'max-redundant-calls'; name: string; max: number }
  | { kind: 'subagent-spawned'; type?: string; minCount?: number; maxCount?: number }
  | { kind: 'subagent-not-spawned' }
  | { kind: 'subagent-parallel'; minCount: number }
  | { kind: 'subagent-final-ok'; minCount?: number }
  | { kind: 'todo-written'; minItems?: number }
  | { kind: 'todo-final-status'; allCompleted?: boolean }

export interface LlmRubric {
  question: string
  scale: 'pass-fail' | '0-5'
  weight?: number
}

// ── Trace ───────────────────────────────────────────────────────

export type TraceStep =
  | { kind: 'assistant-message'; text: string }
  | { kind: 'tool-call'; name: string; args: unknown; id: string; batchId?: string }
  | {
      kind: 'tool-result'
      id: string
      ok: boolean
      data?: unknown
      error?: string
    }
  | {
      kind: 'subagent-spawn'
      subagentId: string
      type: string
      prompt: string
      description: string
      parentCallId: string
      ok: boolean
      finalText?: string
      error?: { code: string; message: string }
      iterations: number
    }

export interface RunTrace {
  taskId: string
  steps: TraceStep[]
  finalAnswer: string
  tokensIn: number
  tokensOut: number
  durationMs: number
  abortReason?: 'max-iter' | 'budget-tokens' | 'timeout' | 'consumer'
}

// ── Run options + LLM config ────────────────────────────────────

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  fetchTimeoutMs?: number
}

export type ReporterId = 'console' | 'markdown' | 'json'

export interface RunOptions {
  llm: LlmConfig
  judgeLLM?: LlmConfig
  filter?: { levels?: TaskLevel[]; tags?: string[]; ids?: string[] }
  parallel?: number
  recordTo?: string
  replayFrom?: string
  reporter: ReporterId[]
  outDir: string
}

// ── Reports ─────────────────────────────────────────────────────

export interface TaskScores {
  completion: number
  traceQuality: number
  efficiency: number
  composite: number
}

export interface TaskReport {
  task: Task
  trace: RunTrace
  scores: TaskScores
  passed: boolean
  failures: string[]
}

export interface SuiteReport {
  schemaVersion: 1
  startedAt: string
  llmModel: string
  totals: { passed: number; failed: number; skipped: number }
  byLevel: Record<TaskLevel, { passed: number; failed: number; meanComposite: number }>
  byTag: Record<string, { passed: number; failed: number; meanComposite: number }>
  meanComposite: number
  meanTokens: number
  meanSteps: number
  tasks: TaskReport[]
}

// ── Suite ───────────────────────────────────────────────────────

export type Suite = Task[]

// ── FixtureCtx (built per-task by runner; consumed by fake tools) ──

export interface FixtureCtx {
  task: Task
  activeTabUrl?: string
  activeTabSnapshot?: string
  state: Map<string, unknown>
  loadSnapshot: (name: string) => string | undefined
  loadCaption: (name: string) => string | undefined
}

export type FakeToolFactory = (ctx: FixtureCtx) => ToolDefinition
