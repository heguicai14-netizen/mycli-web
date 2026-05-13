import { describe, it, expect } from 'vitest'
import { builtinSuite, smokeIds, filterSuite } from '../../../eval/tasks/index'

describe('builtinSuite', () => {
  it('every task has required fields', () => {
    for (const t of builtinSuite) {
      expect(t.id, JSON.stringify(t)).toMatch(/^L[1-4]\//)
      expect(['L1', 'L2', 'L3', 'L4']).toContain(t.level)
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
  it('has 24 tasks total: 6 L1 + 8 L2 + 4 L3 + 6 L4', () => {
    expect(builtinSuite).toHaveLength(24)
    expect(builtinSuite.filter((t) => t.level === 'L1')).toHaveLength(6)
    expect(builtinSuite.filter((t) => t.level === 'L2')).toHaveLength(8)
    expect(builtinSuite.filter((t) => t.level === 'L3')).toHaveLength(4)
    expect(builtinSuite.filter((t) => t.level === 'L4')).toHaveLength(6)
  })
  it('smokeIds all map to real tasks', () => {
    const ids = new Set(builtinSuite.map((t) => t.id))
    for (const id of smokeIds) expect(ids.has(id), id).toBe(true)
  })
  it('filterSuite by level/tag/ids works', () => {
    expect(filterSuite(builtinSuite, { levels: ['L3'] })).toHaveLength(4)
    expect(filterSuite(builtinSuite, { tags: ['data-analysis'] })).toHaveLength(3)
    expect(filterSuite(builtinSuite, { ids: ['L1/extract-title'] })).toHaveLength(1)
  })
})
