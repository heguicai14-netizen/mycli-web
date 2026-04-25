import { openDb, type MessageRow } from './db'
import type { ConversationId, MessageId, Role } from '@shared/types'

function newId(): MessageId {
  return crypto.randomUUID()
}

export async function appendMessage(input: {
  conversationId: ConversationId
  role: Role
  content: unknown
  toolCalls?: unknown[]
  toolResults?: unknown[]
  pending?: boolean
  subAgentId?: string
}): Promise<MessageRow> {
  const db = await openDb()
  const tx = db.transaction(['messages', 'conversations'], 'readwrite')
  const idx = tx.objectStore('messages').index('by-conversation')
  const range = IDBKeyRange.bound(
    [input.conversationId, 0],
    [input.conversationId, Number.MAX_SAFE_INTEGER],
  )
  let maxSeq = -1
  const cursor = await idx.openCursor(range, 'prev')
  if (cursor) maxSeq = cursor.value.seq
  const row: MessageRow = {
    id: newId(),
    conversationId: input.conversationId,
    seq: maxSeq + 1,
    role: input.role,
    content: input.content,
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    createdAt: Date.now(),
    compacted: false,
    pending: input.pending,
    subAgentId: input.subAgentId,
  }
  await tx.objectStore('messages').put(row)
  const convStore = tx.objectStore('conversations')
  const conv = await convStore.get(input.conversationId)
  if (conv) {
    await convStore.put({ ...conv, updatedAt: Date.now() })
  }
  await tx.done
  return row
}

export async function listMessagesByConversation(
  conversationId: ConversationId,
): Promise<MessageRow[]> {
  const db = await openDb()
  const idx = db.transaction('messages').store.index('by-conversation')
  const range = IDBKeyRange.bound(
    [conversationId, 0],
    [conversationId, Number.MAX_SAFE_INTEGER],
  )
  return idx.getAll(range)
}

export async function updateMessage(
  id: MessageId,
  patch: Partial<Omit<MessageRow, 'id' | 'conversationId' | 'seq' | 'createdAt'>>,
): Promise<void> {
  const db = await openDb()
  const current = await db.get('messages', id)
  if (!current) throw new Error(`message ${id} not found`)
  await db.put('messages', { ...current, ...patch })
}

export async function markMessagesCompacted(ids: MessageId[]): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('messages', 'readwrite')
  for (const id of ids) {
    const cur = await tx.store.get(id)
    if (cur) await tx.store.put({ ...cur, compacted: true })
  }
  await tx.done
}

export async function deleteMessagesByConversation(
  conversationId: ConversationId,
): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('messages', 'readwrite')
  const idx = tx.store.index('by-conversation')
  const range = IDBKeyRange.bound(
    [conversationId, 0],
    [conversationId, Number.MAX_SAFE_INTEGER],
  )
  let cursor = await idx.openCursor(range)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}
