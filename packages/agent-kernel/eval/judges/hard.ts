import type { HardAssertion, RunTrace, Task } from '../core/types'
import type { HardJudgeResult } from '../core/runner'

function jsonPath(obj: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined
  const parts = path.slice(1).split('.').filter(Boolean)
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function check(a: HardAssertion, trace: RunTrace, state: Map<string, unknown>): { ok: boolean; reason: string } {
  if (a.kind === 'answer-contains') {
    const ok = a.value instanceof RegExp ? a.value.test(trace.finalAnswer) : trace.finalAnswer.includes(a.value)
    return { ok, reason: `answer-contains(${a.value}): actual=${JSON.stringify(trace.finalAnswer.slice(0, 200))}` }
  }
  if (a.kind === 'answer-equals') {
    const ok = trace.finalAnswer === a.value
    return { ok, reason: `answer-equals(${JSON.stringify(a.value)}): actual=${JSON.stringify(trace.finalAnswer)}` }
  }
  if (a.kind === 'answer-json-path') {
    let parsed: unknown
    try { parsed = JSON.parse(trace.finalAnswer) } catch { parsed = undefined }
    const got = jsonPath(parsed, a.path)
    return {
      ok: JSON.stringify(got) === JSON.stringify(a.equals),
      reason: `answer-json-path(${a.path}=${JSON.stringify(a.equals)}): actual=${JSON.stringify(got)}`,
    }
  }
  // state-equals
  const got = state.get(a.key)
  return {
    ok: JSON.stringify(got) === JSON.stringify(a.value),
    reason: `state-equals(${a.key}=${JSON.stringify(a.value)}): actual=${JSON.stringify(got)}`,
  }
}

export function runHardJudges(task: Task, trace: RunTrace, state: Map<string, unknown>): HardJudgeResult {
  const list = task.judge.completion ?? []
  let passed = 0
  const failures: string[] = []
  for (const a of list) {
    const r = check(a, trace, state)
    if (r.ok) passed++
    else failures.push(r.reason)
  }
  return { passed, total: list.length, failures }
}
