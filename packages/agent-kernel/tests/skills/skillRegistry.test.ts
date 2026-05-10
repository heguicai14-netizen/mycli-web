import { describe, it, expect } from 'vitest'
import { SkillRegistry, type SkillDefinition } from 'agent-kernel'

function makeSkill(name: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    body: `body for ${name}`,
    files: {},
    ...overrides,
  }
}

describe('SkillRegistry', () => {
  it('registers and looks up by name', () => {
    const r = new SkillRegistry()
    r.register(makeSkill('alpha'))
    expect(r.get('alpha')?.description).toBe('desc for alpha')
  })

  it('returns undefined for unknown name', () => {
    expect(new SkillRegistry().get('nope')).toBeUndefined()
  })

  it('throws on duplicate name', () => {
    const r = new SkillRegistry()
    r.register(makeSkill('alpha'))
    expect(() => r.register(makeSkill('alpha'))).toThrow(/duplicate.*alpha/i)
  })

  it('list() returns skills in stable alphabetical order', () => {
    const r = new SkillRegistry()
    r.register(makeSkill('charlie'))
    r.register(makeSkill('alpha'))
    r.register(makeSkill('bravo'))
    expect(r.list().map((s) => s.name)).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('addFile attaches a relative path to an existing skill', () => {
    const r = new SkillRegistry()
    r.register(makeSkill('alpha'))
    r.addFile('alpha', 'references/style.md', '# style')
    expect(r.get('alpha')?.files['references/style.md']).toBe('# style')
  })

  it('addFile throws for an unknown skill', () => {
    const r = new SkillRegistry()
    expect(() => r.addFile('nope', 'x.md', 'x')).toThrow(/nope/)
  })

  it('addFile throws on duplicate path within the same skill', () => {
    const r = new SkillRegistry()
    r.register(makeSkill('alpha'))
    r.addFile('alpha', 'x.md', 'first')
    expect(() => r.addFile('alpha', 'x.md', 'second')).toThrow(/duplicate.*x\.md/i)
  })
})
