import type { IDBPDatabase } from 'idb'
import type { MycliWebSchema } from './db'
import type {
  TodoItem,
  TodoStoreAdapter,
  TodoWriteInput,
} from '../../adapters/TodoStoreAdapter'

export async function createIdbTodoStore(
  db: IDBPDatabase<MycliWebSchema>,
): Promise<TodoStoreAdapter> {
  return {
    async list(conversationId) {
      const row = await db.get('todos', conversationId)
      return row?.items ?? []
    },

    async replace(conversationId, items: TodoWriteInput[]) {
      const tx = db.transaction('todos', 'readwrite')
      const existing = (await tx.store.get(conversationId))?.items ?? []
      const byId = new Map<string, TodoItem>(existing.map((i) => [i.id, i]))
      const now = Date.now()
      const next: TodoItem[] = items.map((input) => {
        const prev = input.id ? byId.get(input.id) : undefined
        return {
          id: prev?.id ?? input.id ?? crypto.randomUUID(),
          subject: input.subject,
          status: input.status,
          description: input.description,
          activeForm: input.activeForm,
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        }
      })
      if (next.length === 0) {
        await tx.store.delete(conversationId)
      } else {
        await tx.store.put({ conversationId, items: next })
      }
      await tx.done
      return next
    },
  }
}
