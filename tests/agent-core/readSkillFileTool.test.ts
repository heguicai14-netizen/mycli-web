import { describe, it, expect } from 'vitest'
import { SkillRegistry, createReadSkillFileTool } from '@core'

function preload(): SkillRegistry {
  const r = new SkillRegistry()
  r.register({
    name: 'summarizePage',
    description: 'd',
    body: 'b',
    files: { 'references/style.md': '# style guide' },
  })
  r.register({
    name: 'translateSelection',
    description: 'd',
    body: 'b',
    files: {},
  })
  return r
}

describe('readSkillFileTool', () => {
  it('description lists available files across all skills', () => {
    const tool = createReadSkillFileTool({ registry: preload() })
    expect(tool.description).toContain('summarizePage/references/style.md')
  })

  it('returns file content for a known skill+path', async () => {
    const tool = createReadSkillFileTool({ registry: preload() })
    const result = await tool.execute(
      { skill: 'summarizePage', path: 'references/style.md' },
      {},
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.content).toBe('# style guide')
  })

  it('returns unknown_skill for an unknown skill', async () => {
    const tool = createReadSkillFileTool({ registry: preload() })
    const result = await tool.execute({ skill: 'nope', path: 'x' }, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown_skill')
  })

  it('returns unknown_path for a known skill but missing path', async () => {
    const tool = createReadSkillFileTool({ registry: preload() })
    const result = await tool.execute(
      { skill: 'summarizePage', path: 'nope.md' },
      {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown_path')
  })

  it('returns unknown_path for a skill with zero files', async () => {
    const tool = createReadSkillFileTool({ registry: preload() })
    const result = await tool.execute(
      { skill: 'translateSelection', path: 'anything.md' },
      {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown_path')
  })
})
