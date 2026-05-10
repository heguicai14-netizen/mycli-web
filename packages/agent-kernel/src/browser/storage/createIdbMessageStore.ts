import {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
  markMessagesCompacted,
  deleteMessagesByConversation,
} from './messages'
import {
  createConversation,
  getConversation,
  listConversations,
  deleteConversation as deleteConversationRow,
} from './conversations'
import type {
  MessageStoreAdapter,
  MessageRecord,
  ConversationSummary,
} from '../../adapters/MessageStoreAdapter'

export interface CreateIdbMessageStoreOptions {
  /** The default conversation title used when a new conversation is created. */
  defaultConversationTitle?: string
}

/**
 * Default IndexedDB-backed MessageStoreAdapter that wraps the kernel's
 * conversation/message stores. Consumers wanting a different persistence
 * strategy can implement MessageStoreAdapter directly.
 */
// Stored in chrome.storage.local so the user's selected conversation survives
// SW restarts and tab reloads. Falls back to "latest" if missing or stale.
const ACTIVE_KEY = 'agent-kernel-active-conversation-id'

async function getStoredActive(): Promise<string | undefined> {
  try {
    const r = await chrome.storage.local.get(ACTIVE_KEY)
    const v = r[ACTIVE_KEY]
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

async function setStoredActive(id: string | null): Promise<void> {
  try {
    if (id === null) await chrome.storage.local.remove(ACTIVE_KEY)
    else await chrome.storage.local.set({ [ACTIVE_KEY]: id })
  } catch {
    // chrome.storage may be unavailable in tests; fall through silently.
  }
}

function toSummary(c: {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

export function createIdbMessageStore(
  opts: CreateIdbMessageStoreOptions = {},
): MessageStoreAdapter {
  const title = opts.defaultConversationTitle ?? 'New chat'
  return {
    async activeConversationId() {
      // 1) Prefer explicitly selected, if it still exists.
      const stored = await getStoredActive()
      if (stored) {
        const found = await getConversation(stored)
        if (found) return stored
        // Stale active id (conversation was deleted) — clear it.
        await setStoredActive(null)
      }
      // 2) Otherwise, fall back to most-recently-updated.
      const all = await listConversations()
      if (all.length > 0) return all[0].id
      // 3) Lazy-create on first ever turn.
      const conv = await createConversation({ title })
      return conv.id
    },
    async setActiveConversationId(id) {
      await setStoredActive(id)
    },
    async listConversations() {
      const rows = await listConversations()
      return rows.map(toSummary)
    },
    async createConversation(o) {
      const conv = await createConversation({ title: o?.title ?? title })
      await setStoredActive(conv.id)
      return toSummary(conv)
    },
    async deleteConversation(id) {
      // Wipe messages first, then the row itself, then clear active if needed.
      await deleteMessagesByConversation(id)
      await deleteConversationRow(id)
      const stored = await getStoredActive()
      if (stored === id) await setStoredActive(null)
    },
    async append(msg) {
      const row = await appendMessage(msg)
      return { id: row.id, createdAt: row.createdAt }
    },
    async list(conversationId): Promise<MessageRecord[]> {
      const rows = await listMessagesByConversation(conversationId)
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.createdAt,
        pending: r.pending,
        compacted: r.compacted,
        toolCalls: r.toolCalls,
        toolCallId: r.toolCallId,
      }))
    },
    async update(id, patch) {
      await updateMessage(id, patch)
    },
    async markCompacted(ids) {
      await markMessagesCompacted(ids)
    },
  }
}
