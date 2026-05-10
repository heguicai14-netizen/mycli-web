import { openDb, type SkillRow } from './db'
import type { SkillId } from 'agent-kernel'

export async function putSkill(row: SkillRow): Promise<void> {
  const db = await openDb()
  await db.put('skills', row)
}

export async function getSkill(id: SkillId): Promise<SkillRow | undefined> {
  const db = await openDb()
  return db.get('skills', id)
}

export async function listSkills(): Promise<SkillRow[]> {
  const db = await openDb()
  const all = await db.getAll('skills')
  return all.sort((a, b) => b.installedAt - a.installedAt)
}

export async function setSkillEnabled(id: SkillId, enabled: boolean): Promise<void> {
  const db = await openDb()
  const cur = await db.get('skills', id)
  if (!cur) throw new Error(`skill ${id} not found`)
  await db.put('skills', { ...cur, enabled })
}

export async function deleteSkill(id: SkillId): Promise<void> {
  const db = await openDb()
  await db.delete('skills', id)
}
