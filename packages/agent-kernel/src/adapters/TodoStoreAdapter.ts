import type { ConversationId, TodoStatus } from '../core/types'

export interface TodoItem {
  id: string
  subject: string
  status: TodoStatus
  description?: string
  activeForm?: string
  createdAt: number
  updatedAt: number
}

export type TodoWriteInput = {
  /** Provide to preserve existing item's createdAt + id. Omit for new items. */
  id?: string
  subject: string
  status: TodoStatus
  description?: string
  activeForm?: string
}

export interface TodoStoreAdapter {
  /** List current todos for a conversation. Empty array if none. */
  list(conversationId: ConversationId): Promise<TodoItem[]>
  /**
   * Atomically replace the entire list. Items WITH id preserve original
   * createdAt + id; new items get fresh uuid + createdAt. updatedAt is
   * bumped on every replace for every item in the new list (no content-
   * diff heuristic — semantics are intentionally simple). Items absent
   * from input are removed. Returns the canonical post-replace state.
   */
  replace(
    conversationId: ConversationId,
    items: TodoWriteInput[],
  ): Promise<TodoItem[]>
}
