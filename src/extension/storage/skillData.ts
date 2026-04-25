import { openDb, type SkillDataRow } from './db'
import type { SkillId } from '@shared/types'

export async function setSkillValue(skillId: SkillId, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  await db.put('skillData', { skillId, key, value })
}

export async function getSkillValue(skillId: SkillId, key: string): Promise<unknown | undefined> {
  const db = await openDb()
  const row = await db.get('skillData', [skillId, key])
  return row?.value
}

export async function listSkillValues(skillId: SkillId): Promise<SkillDataRow[]> {
  const db = await openDb()
  const range = IDBKeyRange.bound([skillId, ''], [skillId, '￿'])
  return db.getAll('skillData', range)
}

export async function clearSkillValues(skillId: SkillId): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('skillData', 'readwrite')
  const range = IDBKeyRange.bound([skillId, ''], [skillId, '￿'])
  let cursor = await tx.store.openCursor(range)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}
