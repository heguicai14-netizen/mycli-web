import type { SuiteReport } from '../types'

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function renderJson(r: SuiteReport): string {
  return JSON.stringify(sortKeysDeep(r), null, 2)
}
