import { describe, it, expect } from 'vitest'
import { loadSkillsFromViteGlob as buildRegistryFromModules } from 'agent-kernel'

const goodSkill = `---
name: summarizePage
description: Summarize the active page.
---

# Instructions
Step 1.`

const styleRef = '# style guide\n- be terse'

describe('buildRegistryFromModules', () => {
  it('groups files by folder name and registers entries + reference files', () => {
    const modules = {
      './skills/summarizePage/SKILL.md': goodSkill,
      './skills/summarizePage/references/style.md': styleRef,
    }
    const registry = buildRegistryFromModules(modules)

    const skill = registry.get('summarizePage')
    expect(skill).toBeDefined()
    expect(skill?.body).toContain('# Instructions')
    expect(skill?.files['references/style.md']).toBe(styleRef)
  })

  it('throws when a skill folder has no SKILL.md', () => {
    const modules = {
      './skills/orphan/references/x.md': '# x',
    }
    expect(() => buildRegistryFromModules(modules)).toThrow(
      /orphan.*SKILL\.md/,
    )
  })

  it('throws when frontmatter name does not match folder name', () => {
    const mismatch = `---
name: somethingElse
description: x
---
body`
    const modules = { './skills/summarizePage/SKILL.md': mismatch }
    expect(() => buildRegistryFromModules(modules)).toThrow(
      /summarizePage.*somethingElse/,
    )
  })

  it('handles multiple skills independently', () => {
    const second = goodSkill.replace(/summarizePage/, 'translateSelection')
    const modules = {
      './skills/summarizePage/SKILL.md': goodSkill,
      './skills/translateSelection/SKILL.md': second,
    }
    const registry = buildRegistryFromModules(modules)
    expect(registry.list().map((s) => s.name)).toEqual([
      'summarizePage',
      'translateSelection',
    ])
  })

  it('ignores paths outside ./skills/ silently', () => {
    const modules = {
      './skills/summarizePage/SKILL.md': goodSkill,
      './something/else.md': '# stray',
    }
    const registry = buildRegistryFromModules(modules)
    // 'something' was not under skills/, so no skill named 'something' exists.
    expect(registry.get('something')).toBeUndefined()
    expect(registry.get('summarizePage')).toBeDefined()
  })

  it('throws when a skill folder is nested deeper than one level', () => {
    // skills/parent/child/SKILL.md is not allowed.
    const modules = {
      './skills/parent/child/SKILL.md': goodSkill,
    }
    expect(() => buildRegistryFromModules(modules)).toThrow(
      /parent.*SKILL\.md/,
    )
  })
})
