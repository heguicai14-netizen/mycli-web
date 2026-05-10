export interface MessageRecord {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system-synth'
  content: unknown
  createdAt: number
  pending?: boolean
  compacted?: boolean
}

export interface AppendMessageInput {
  conversationId: string
  role: 'user' | 'assistant' | 'system-synth'
  content: string
  pending?: boolean
}

export interface AppendedMessage {
  id: string
  createdAt: number
}

export interface MessageStoreAdapter {
  activeConversationId(): Promise<string>
  append(msg: AppendMessageInput): Promise<AppendedMessage>
  list(conversationId: string): Promise<MessageRecord[]>
  update(id: string, patch: { content?: string; pending?: boolean }): Promise<void>
  /**
   * Mark messages as compacted (excluded from future LLM history). Optional —
   * stores that don't implement this opt out of auto-compaction. Implementations
   * should be idempotent: marking an already-compacted message is a no-op.
   */
  markCompacted?(ids: string[]): Promise<void>
}
