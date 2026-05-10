import { openDb, type AuditLogRow } from './db'
import type { ConversationId } from 'agent-kernel'

export async function appendAudit(input: {
  conversationId?: ConversationId
  tool: string
  argsSummary: string
  resultSummary: string
  approvalUsed?: string
  outcome: AuditLogRow['outcome']
}): Promise<AuditLogRow> {
  const db = await openDb()
  const row: AuditLogRow = {
    id: crypto.randomUUID(),
    conversationId: input.conversationId,
    ts: Date.now(),
    tool: input.tool,
    argsSummary: input.argsSummary,
    resultSummary: input.resultSummary,
    approvalUsed: input.approvalUsed,
    outcome: input.outcome,
  }
  await db.put('auditLog', row)
  return row
}

export async function listAuditByConversation(
  conversationId: ConversationId,
): Promise<AuditLogRow[]> {
  const db = await openDb()
  return db.getAllFromIndex('auditLog', 'by-conversation', conversationId)
}

export async function listAuditByTimeRange(from: number, to: number): Promise<AuditLogRow[]> {
  const db = await openDb()
  const range = IDBKeyRange.bound(from, to)
  return db.getAllFromIndex('auditLog', 'by-time', range)
}

export async function pruneAuditOlderThan(cutoffTs: number): Promise<number> {
  const db = await openDb()
  const tx = db.transaction('auditLog', 'readwrite')
  const idx = tx.store.index('by-time')
  const range = IDBKeyRange.upperBound(cutoffTs, true)
  let cursor = await idx.openCursor(range)
  let removed = 0
  while (cursor) {
    await cursor.delete()
    removed++
    cursor = await cursor.continue()
  }
  await tx.done
  return removed
}
