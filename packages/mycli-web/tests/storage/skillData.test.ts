import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import {
  setSkillValue,
  getSkillValue,
  listSkillValues,
  clearSkillValues,
} from '@ext/storage/skillData'

describe('skillData store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('set then get returns same value', async () => {
    await setSkillValue('skillA', 'k', { n: 1 })
    expect(await getSkillValue('skillA', 'k')).toEqual({ n: 1 })
  })

  it('isolates values per skillId', async () => {
    await setSkillValue('skillA', 'k', 'a')
    await setSkillValue('skillB', 'k', 'b')
    expect(await getSkillValue('skillA', 'k')).toBe('a')
    expect(await getSkillValue('skillB', 'k')).toBe('b')
  })

  it('listSkillValues returns only values for that skill', async () => {
    await setSkillValue('skillA', 'k1', 'v1')
    await setSkillValue('skillA', 'k2', 'v2')
    await setSkillValue('skillB', 'k1', 'other')
    const rows = await listSkillValues('skillA')
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.key).sort()).toEqual(['k1', 'k2'])
  })

  it('clearSkillValues wipes a skills bucket', async () => {
    await setSkillValue('skillA', 'k1', 'v1')
    await setSkillValue('skillB', 'k1', 'keep')
    await clearSkillValues('skillA')
    expect((await listSkillValues('skillA')).length).toBe(0)
    expect((await listSkillValues('skillB')).length).toBe(1)
  })
})
