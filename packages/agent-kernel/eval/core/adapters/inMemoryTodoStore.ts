import type {
  TodoStoreAdapter,
  TodoItem,
  TodoWriteInput,
} from '../../../src/adapters/TodoStoreAdapter'
import type { ConversationId } from '../../../src/core/types'

export class InMemoryTodoStore implements TodoStoreAdapter {
  private store = new Map<string, TodoItem[]>()

  async list(conversationId: ConversationId): Promise<TodoItem[]> {
    return this.store.get(String(conversationId)) ?? []
  }

  async replace(
    conversationId: ConversationId,
    items: TodoWriteInput[],
  ): Promise<TodoItem[]> {
    const cid = String(conversationId)
    const now = Date.now()
    const prev = this.store.get(cid) ?? []
    const prevById = new Map(prev.map((p) => [p.id, p]))
    const next: TodoItem[] = items.map((it) => {
      const existing = it.id ? prevById.get(it.id) : undefined
      return {
        id: it.id ?? crypto.randomUUID(),
        subject: it.subject,
        status: it.status,
        description: it.description,
        activeForm: it.activeForm,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
    })
    if (next.length === 0) this.store.delete(cid)
    else this.store.set(cid, next)
    return next
  }
}
