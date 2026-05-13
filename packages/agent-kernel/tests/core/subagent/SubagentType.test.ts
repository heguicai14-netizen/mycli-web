import { describe, it, expect } from 'vitest'
import {
  buildSubagentTypeRegistry,
  type SubagentType,
} from '../../../src/core/subagent/SubagentType'

const minimal = (name: string): SubagentType => ({
  name,
  description: 'd',
  systemPrompt: 's',
  allowedTools: '*',
})

describe('buildSubagentTypeRegistry', () => {
  it('returns empty map for empty array', () => {
    const r = buildSubagentTypeRegistry([])
    expect(r.size).toBe(0)
  })

  it('builds a Map keyed by name', () => {
    const r = buildSubagentTypeRegistry([minimal('alpha'), minimal('beta')])
    expect(r.size).toBe(2)
    expect(r.get('alpha')?.name).toBe('alpha')
    expect(r.get('beta')?.name).toBe('beta')
  })

  it('throws on duplicate names', () => {
    expect(() =>
      buildSubagentTypeRegistry([minimal('x'), minimal('x')]),
    ).toThrow(/duplicate/i)
  })

  it.each([
    ['Capital'],
    ['1leading-digit'],
    ['has space'],
    ['has_under$core'],
    [''],
  ])('throws on invalid name format: %s', (bad) => {
    expect(() => buildSubagentTypeRegistry([minimal(bad)])).toThrow(/name/i)
  })

  it('accepts valid names matching /^[a-z][a-z0-9_-]*$/', () => {
    expect(() =>
      buildSubagentTypeRegistry([
        minimal('a'),
        minimal('general-purpose'),
        minimal('explore_v2'),
      ]),
    ).not.toThrow()
  })
})
