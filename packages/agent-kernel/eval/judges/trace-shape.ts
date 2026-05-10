import type { Task, RunTrace, TraceAssertion } from '../core/types'
import type { TraceJudgeResult } from '../core/runner'

function normalizeArgs(a: unknown): string {
  if (a === null || typeof a !== 'object') return JSON.stringify(a)
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (k === 'signal' || k === 'abort') continue
        out[k] = walk((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  return JSON.stringify(walk(a))
}

function partialMatch(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object') return false
  const a = actual as Record<string, unknown>
  for (const [k, v] of Object.entries(expected)) {
    if (v instanceof RegExp) {
      if (typeof a[k] !== 'string' || !v.test(a[k] as string)) return false
    } else if (typeof v === 'object' && v !== null) {
      if (!partialMatch(a[k], v as Record<string, unknown>)) return false
    } else if (a[k] !== v) {
      return false
    }
  }
  return true
}

function checkAssertion(a: TraceAssertion, trace: RunTrace): { ok: boolean; reason: string } {
  const calls = trace.steps.filter((s) => s.kind === 'tool-call') as Array<Extract<typeof trace.steps[number], { kind: 'tool-call' }>>
  if (a.kind === 'tool-called') {
    const matches = calls.filter((c) => c.name === a.name && (!a.argsMatch || partialMatch(c.args, a.argsMatch)))
    return { ok: matches.length > 0, reason: `tool-called(${a.name}${a.argsMatch ? `, ${JSON.stringify(a.argsMatch)}` : ''}): ${matches.length} matches` }
  }
  if (a.kind === 'tool-not-called') {
    const found = calls.some((c) => c.name === a.name)
    return { ok: !found, reason: `tool-not-called(${a.name}): actual=${found ? 'called' : 'not called'}` }
  }
  if (a.kind === 'tool-order') {
    const names = calls.map((c) => c.name)
    if (a.strict) {
      const window = names.slice(0, a.sequence.length)
      const ok = window.length === a.sequence.length && window.every((n, i) => n === a.sequence[i])
      return { ok, reason: `tool-order(strict ${a.sequence.join(',')}): actual=${names.join(',')}` }
    }
    let i = 0
    for (const n of names) if (n === a.sequence[i]) i++
    const ok = i === a.sequence.length
    return { ok, reason: `tool-order(${a.sequence.join(',')}): actual=${names.join(',')}` }
  }
  // max-redundant-calls
  const buckets = new Map<string, number>()
  for (const c of calls) {
    if (c.name !== a.name) continue
    const key = `${c.name}|${normalizeArgs(c.args)}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  let redundant = 0
  for (const v of buckets.values()) if (v > 1) redundant += v - 1
  const ok = redundant <= a.max
  return { ok, reason: `max-redundant-calls(${a.name}, max=${a.max}): actual=${redundant}` }
}

export function runTraceJudges(task: Task, trace: RunTrace): TraceJudgeResult {
  const asserts = task.judge.trace ?? []
  let passed = 0
  const failures: string[] = []
  for (const a of asserts) {
    const r = checkAssertion(a, trace)
    if (r.ok) passed++
    else failures.push(r.reason)
  }
  const callRate = asserts.length === 0 ? 1 : passed / asserts.length

  let redundancy = 0
  let redundancyMax = 0
  const callsAll = trace.steps.filter((s) => s.kind === 'tool-call') as Array<Extract<typeof trace.steps[number], { kind: 'tool-call' }>>
  for (const a of asserts) {
    if (a.kind !== 'max-redundant-calls') continue
    redundancyMax += a.max
    const buckets = new Map<string, number>()
    for (const c of callsAll) {
      if (c.name !== a.name) continue
      const key = `${c.name}|${normalizeArgs(c.args)}`
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
    for (const v of buckets.values()) if (v > 1) redundancy += v - 1
  }
  if (redundancyMax === 0) redundancyMax = 1

  let hadFailure = false
  let recoveryScore: 0 | 0.5 | 1 = 1
  let sawFailureWithoutFollowup = false
  let sawRecovery = false
  let sawSameRetry = false
  for (let i = 0; i < trace.steps.length; i++) {
    const s = trace.steps[i]
    if (s.kind !== 'tool-result' || s.ok) continue
    hadFailure = true
    const failedCall = callsAll.find((c) => c.id === s.id)
    if (!failedCall) continue
    const nextCall = trace.steps.slice(i + 1).find((x) => x.kind === 'tool-call') as
      | Extract<typeof trace.steps[number], { kind: 'tool-call' }> | undefined
    if (!nextCall) { sawFailureWithoutFollowup = true; continue }
    const same = nextCall.name === failedCall.name && normalizeArgs(nextCall.args) === normalizeArgs(failedCall.args)
    if (same) sawSameRetry = true
    else sawRecovery = true
  }
  if (hadFailure) {
    if (sawSameRetry) recoveryScore = 0
    else if (sawRecovery) recoveryScore = 1
    else if (sawFailureWithoutFollowup) recoveryScore = 0.5
    else recoveryScore = 0
  }

  return { callRate, redundancy, redundancyMax, hadFailure, recoveryScore, failures }
}
