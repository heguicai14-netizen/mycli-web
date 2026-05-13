import { openDB, deleteDB, type IDBPDatabase, type DBSchema } from 'idb'
import type { ConversationId, MessageId, SkillId } from '../../core/types'
import type { TodoItem } from '../../adapters/TodoStoreAdapter'

export const DB_NAME = 'agent-kernel'
export const DB_VERSION = 2

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
  /** Set on assistant rows that produced tool calls in this iteration. Each
   *  entry mirrors the agent-core ToolCall shape so the row can be replayed
   *  back into the OpenAI chat format on the next turn. */
  toolCalls?: Array<{ id: string; name: string; input?: unknown }>
  /** Set on tool rows: the id of the assistant tool_call this row answers.
   *  Required by OpenAI for proper pairing in chat completions. */
  toolCallId?: string
  /** Legacy/unused. Retained to keep the schema additive — tool results live
   *  in dedicated tool rows now (one row per result), not embedded here. */
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
  todos: {
    key: string // conversationId
    value: {
      conversationId: string
      items: TodoItem[]
    }
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
      if (oldVersion < 2) {
        db.createObjectStore('todos', { keyPath: 'conversationId' })
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
