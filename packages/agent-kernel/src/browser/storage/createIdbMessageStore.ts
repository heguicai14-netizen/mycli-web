import {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
  markMessagesCompacted,
} from './messages'
import {
  createConversation,
  listConversations,
} from './conversations'
import type {
  MessageStoreAdapter,
  MessageRecord,
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
export function createIdbMessageStore(
  opts: CreateIdbMessageStoreOptions = {},
): MessageStoreAdapter {
  const title = opts.defaultConversationTitle ?? 'New chat'
  return {
    async activeConversationId() {
      const all = await listConversations()
      if (all.length > 0) return all[0].id
      const conv = await createConversation({ title })
      return conv.id
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
