import { openDB, deleteDB, type IDBPDatabase, type DBSchema } from 'idb'
import type { ConversationId, MessageId, SkillId } from 'agent-kernel'

export const DB_NAME = 'mycli-web'
export const DB_VERSION = 1

export interface ConversationRow {
  id: ConversationId
  title: string
  createdAt: number
  updatedAt: number
  pinnedTabId?: number
  lastActiveTabUrl?: string
  compactionCount: number
}

export interface MessageRow {
  id: MessageId
  conversationId: ConversationId
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system-synth'
  content: unknown
  toolCalls?: unknown[]
  toolResults?: unknown[]
  createdAt: number
  compacted: boolean
  pending?: boolean
  subAgentId?: string
}

export interface SkillRow {
  id: SkillId
  name: string
  version: string
  manifest: unknown
  bodyMarkdown: string
  toolsCode?: string
  hashes: Record<string, string>
  source: { kind: 'bundled' | 'file' | 'url'; path?: string; url?: string }
  installedAt: number
  enabled: boolean
}

export interface SkillDataRow {
  skillId: SkillId
  key: string
  value: unknown
}

export interface AuditLogRow {
  id: string
  conversationId?: ConversationId
  ts: number
  tool: string
  argsSummary: string
  resultSummary: string
  approvalUsed?: string
  outcome: 'ok' | 'denied' | 'error'
}

export interface MycliWebSchema extends DBSchema {
  conversations: { key: ConversationId; value: ConversationRow }
  messages: {
    key: MessageId
    value: MessageRow
    indexes: { 'by-conversation': [ConversationId, number] }
  }
  skills: { key: SkillId; value: SkillRow }
  skillData: { key: [SkillId, string]; value: SkillDataRow }
  auditLog: {
    key: string
    value: AuditLogRow
    indexes: { 'by-conversation': ConversationId; 'by-time': number }
  }
}

let _db: IDBPDatabase<MycliWebSchema> | null = null

export async function openDb(): Promise<IDBPDatabase<MycliWebSchema>> {
  if (_db) return _db
  _db = await openDB<MycliWebSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('conversations', { keyPath: 'id' })
        const msgs = db.createObjectStore('messages', { keyPath: 'id' })
        msgs.createIndex('by-conversation', ['conversationId', 'seq'], { unique: false })
        db.createObjectStore('skills', { keyPath: 'id' })
        db.createObjectStore('skillData', { keyPath: ['skillId', 'key'] })
        const audit = db.createObjectStore('auditLog', { keyPath: 'id' })
        audit.createIndex('by-conversation', 'conversationId', { unique: false })
        audit.createIndex('by-time', 'ts', { unique: false })
      }
    },
  })
  return _db
}

export async function resetDbForTests(): Promise<void> {
  if (_db) {
    _db.close()
    _db = null
  }
  await deleteDB(DB_NAME)
}
