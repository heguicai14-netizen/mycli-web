import { describe, it, expect } from 'vitest'
import { builtinSuite } from '../../../eval/tasks/index'

describe('builtinSuite', () => {
  it('every task has required fields', () => {
    for (const t of builtinSuite) {
      expect(t.id, JSON.stringify(t)).toMatch(/^L[1-3]\//)
      expect(['L1', 'L2', 'L3']).toContain(t.level)
      expect(t.prompt.length).toBeGreaterThan(0)
      expect(t.budget.maxSteps).toBeGreaterThan(0)
    }
  })
  it('task ids are unique', () => {
    const ids = new Set<string>()
    for (const t of builtinSuite) {
      expect(ids.has(t.id), `dup id: ${t.id}`).toBe(false)
      ids.add(t.id)
    }
  })
})
