import { describe, it, expect } from 'vitest'
import { parseSkillMd } from '@core'

describe('parseSkillMd', () => {
  it('extracts frontmatter and body for a well-formed skill', () => {
    const raw = [
      '---',
      'name: summarizePage',
      'description: Summarize the active web page in three bullets.',
      '---',
      '',
      '# Instructions',
      '',
      'Step 1. Do the thing.',
      '',
    ].join('\n')

    const out = parseSkillMd(raw, 'skills/summarizePage/SKILL.md')

    expect(out.name).toBe('summarizePage')
    expect(out.description).toBe('Summarize the active web page in three bullets.')
    expect(out.body).toBe('# Instructions\n\nStep 1. Do the thing.\n')
    expect(out.meta).toEqual({})
  })

  it('captures unknown frontmatter keys into meta', () => {
    const raw = [
      '---',
      'name: x',
      'description: x',
      'author: alice',
      'version: 0.1',
      '---',
      'body',
    ].join('\n')

    const out = parseSkillMd(raw, 's')
    expect(out.meta).toEqual({ author: 'alice', version: '0.1' })
  })

  it('preserves an empty body', () => {
    const raw = ['---', 'name: x', 'description: x', '---', ''].join('\n')
    expect(parseSkillMd(raw, 's').body).toBe('')
  })

  it('throws when frontmatter is missing', () => {
    expect(() => parseSkillMd('# just body', 's/SKILL.md')).toThrow(
      /missing frontmatter/i,
    )
  })

  it('throws when name is missing', () => {
    const raw = ['---', 'description: x', '---', ''].join('\n')
    expect(() => parseSkillMd(raw, 's/SKILL.md')).toThrow(/name/i)
  })

  it('throws when description is missing', () => {
    const raw = ['---', 'name: x', '---', ''].join('\n')
    expect(() => parseSkillMd(raw, 's/SKILL.md')).toThrow(/description/i)
  })

  it('throws when name is empty', () => {
    const raw = ['---', 'name:', 'description: x', '---', ''].join('\n')
    expect(() => parseSkillMd(raw, 's/SKILL.md')).toThrow(/name/i)
  })
})
