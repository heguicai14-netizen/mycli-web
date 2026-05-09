import { describe, it, expect } from 'vitest'
import { SkillRegistry, createUseSkillTool } from '@core'

function preload(): SkillRegistry {
  const r = new SkillRegistry()
  r.register({
    name: 'summarizePage',
    description: 'Summarize the current page in three bullets.',
    body: 'Step 1. Use readPage.\nStep 2. Output bullets.',
    files: {},
  })
  r.register({
    name: 'translateSelection',
    description: 'Translate the selected text.',
    body: 'Step 1. Read selection.',
    files: { 'references/glossary.md': 'foo => bar' },
  })
  return r
}

describe('useSkillTool', () => {
  it('description lists every registered skill name + description', () => {
    const tool = createUseSkillTool({ registry: preload() })
    expect(tool.description).toContain('summarizePage')
    expect(tool.description).toContain('Summarize the current page in three bullets.')
    expect(tool.description).toContain('translateSelection')
    expect(tool.description).toContain('Translate the selected text.')
  })

  it('description reflects later registrations (lazy)', () => {
    const r = new SkillRegistry()
    const tool = createUseSkillTool({ registry: r })
    expect(tool.description).not.toContain('lateSkill')
    r.register({
      name: 'lateSkill',
      description: 'Added after tool creation.',
      body: 'b',
      files: {},
    })
    expect(tool.description).toContain('lateSkill')
  })

  it('execute returns body for a known skill', async () => {
    const tool = createUseSkillTool({ registry: preload() })
    const result = await tool.execute({ skill: 'summarizePage' }, {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content).toContain('Step 1. Use readPage.')
    }
  })

  it('appends a "Related files" manifest when the skill has files', async () => {
    const tool = createUseSkillTool({ registry: preload() })
    const result = await tool.execute({ skill: 'translateSelection' }, {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content).toContain('Related files')
      expect(result.data.content).toContain('references/glossary.md')
    }
  })

  it('omits the "Related files" manifest when the skill has none', async () => {
    const tool = createUseSkillTool({ registry: preload() })
    const result = await tool.execute({ skill: 'summarizePage' }, {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content).not.toContain('Related files')
    }
  })

  it('returns unknown_skill for an unknown name', async () => {
    const tool = createUseSkillTool({ registry: preload() })
    const result = await tool.execute({ skill: 'noSuchSkill' }, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown_skill')
  })
})
