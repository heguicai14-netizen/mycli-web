import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import {
  putSkill,
  getSkill,
  listSkills,
  setSkillEnabled,
  deleteSkill,
} from '@ext/storage/skills'
import type { SkillRow } from '@ext/storage/db'

function makeSkill(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: 'sample@1.0.0',
    name: 'sample',
    version: '1.0.0',
    manifest: {},
    bodyMarkdown: '# sample',
    hashes: {},
    source: { kind: 'file' },
    installedAt: Date.now(),
    enabled: true,
    ...overrides,
  }
}

describe('skills store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('puts and fetches', async () => {
    const s = makeSkill()
    await putSkill(s)
    expect(await getSkill(s.id)).toEqual(s)
  })

  it('lists skills sorted by installedAt desc', async () => {
    await putSkill(makeSkill({ id: 'a@1', name: 'a', installedAt: 100 }))
    await putSkill(makeSkill({ id: 'b@1', name: 'b', installedAt: 200 }))
    const list = await listSkills()
    expect(list.map((s) => s.id)).toEqual(['b@1', 'a@1'])
  })

  it('setSkillEnabled toggles', async () => {
    await putSkill(makeSkill({ enabled: false }))
    await setSkillEnabled('sample@1.0.0', true)
    expect((await getSkill('sample@1.0.0'))!.enabled).toBe(true)
  })

  it('deleteSkill removes', async () => {
    await putSkill(makeSkill())
    await deleteSkill('sample@1.0.0')
    expect(await getSkill('sample@1.0.0')).toBeUndefined()
  })
})
