import { openDb, type ConversationRow } from './db'
import type { ConversationId } from '@core'

function newId(): ConversationId {
  return crypto.randomUUID()
}

export async function createConversation(input: {
  title: string
  pinnedTabId?: number
  lastActiveTabUrl?: string
}): Promise<ConversationRow> {
  const db = await openDb()
  const now = Date.now()
  const row: ConversationRow = {
    id: newId(),
    title: input.title,
    createdAt: now,
    updatedAt: now,
    pinnedTabId: input.pinnedTabId,
    lastActiveTabUrl: input.lastActiveTabUrl,
    compactionCount: 0,
  }
  await db.put('conversations', row)
  return row
}

export async function getConversation(id: ConversationId): Promise<ConversationRow | undefined> {
  const db = await openDb()
  return db.get('conversations', id)
}

export async function listConversations(): Promise<ConversationRow[]> {
  const db = await openDb()
  const all = await db.getAll('conversations')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function updateConversation(
  id: ConversationId,
  patch: Partial<Omit<ConversationRow, 'id' | 'createdAt'>>,
): Promise<void> {
  const db = await openDb()
  const current = await db.get('conversations', id)
  if (!current) throw new Error(`conversation ${id} not found`)
  const next: ConversationRow = { ...current, ...patch, updatedAt: Date.now() }
  await db.put('conversations', next)
}

export async function deleteConversation(id: ConversationId): Promise<void> {
  const db = await openDb()
  await db.delete('conversations', id)
}
