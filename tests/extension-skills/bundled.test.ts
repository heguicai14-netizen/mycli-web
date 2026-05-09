import { describe, it, expect } from 'vitest'
import { skillRegistry, useSkillTool, readSkillFileTool } from '@ext-skills'

describe('bundled skills (via real Vite glob)', () => {
  it('loads summarizePage with description, body, and reference file', () => {
    const skill = skillRegistry.get('summarizePage')
    expect(skill).toBeDefined()
    if (!skill) return
    expect(skill.description).toMatch(/three.*bullet/i)
    expect(skill.body).toContain('readPage')
    expect(skill.files['references/style.md']).toBeDefined()
    expect(skill.files['references/style.md']).toMatch(/tone|voice/i)
  })

  it('exposes useSkill tool whose description lists summarizePage', () => {
    expect(useSkillTool.description).toContain('summarizePage')
  })

  it("exposes readSkillFile tool whose description lists summarizePage's reference path", () => {
    expect(readSkillFileTool.description).toContain(
      'summarizePage/references/style.md',
    )
  })

  it('useSkill execute on summarizePage returns body + manifest', async () => {
    const result = await useSkillTool.execute({ skill: 'summarizePage' }, {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content).toContain('readPage')
      expect(result.data.content).toContain('Related files')
      expect(result.data.content).toContain('references/style.md')
    }
  })

  it('readSkillFile execute returns the style reference content', async () => {
    const result = await readSkillFileTool.execute(
      { skill: 'summarizePage', path: 'references/style.md' },
      {},
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.content).toMatch(/tone|voice/i)
  })
})
