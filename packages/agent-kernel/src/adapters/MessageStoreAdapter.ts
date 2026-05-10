export interface MessageRecord {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system-synth'
  content: unknown
  createdAt: number
  pending?: boolean
  compacted?: boolean
  /** Tool calls the LLM emitted in the assistant iteration this row represents. */
  toolCalls?: Array<{ id: string; name: string; input?: unknown }>
  /** For tool rows: the assistant tool_call id this row responds to. */
  toolCallId?: string
}

export interface AppendMessageInput {
  conversationId: string
  role: 'user' | 'assistant' | 'system-synth' | 'tool'
  content: string
  pending?: boolean
  /** Required on assistant rows that produced tool_calls in their iteration. */
  toolCalls?: Array<{ id: string; name: string; input?: unknown }>
  /** Required on tool rows: the assistant tool_call id this answers. */
  toolCallId?: string
}

export interface AppendedMessage {
  id: string
  createdAt: number
}

export interface UpdateMessagePatch {
  content?: string
  pending?: boolean
  toolCalls?: Array<{ id: string; name: string; input?: unknown }>
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface MessageStoreAdapter {
  activeConversationId(): Promise<string>
  append(msg: AppendMessageInput): Promise<AppendedMessage>
  list(conversationId: string): Promise<MessageRecord[]>
  update(id: string, patch: UpdateMessagePatch): Promise<void>
  /**
   * Mark messages as compacted (excluded from future LLM history). Optional —
   * stores that don't implement this opt out of auto-compaction. Implementations
   * should be idempotent: marking an already-compacted message is a no-op.
   */
  markCompacted?(ids: string[]): Promise<void>
  /**
   * Multi-conversation management. All four are optional so a custom adapter
   * (e.g. an in-memory test stub) can opt out — the kernel's offscreen cmd
   * handlers degrade to no-ops when these are missing.
   *
   * Adapters that implement these MUST keep activeConversationId() consistent:
   * a successful setActiveConversationId(x) means subsequent
   * activeConversationId() returns x until either set again or x is deleted.
   */
  setActiveConversationId?(id: string): Promise<void>
  listConversations?(): Promise<ConversationSummary[]>
  createConversation?(opts?: { title?: string }): Promise<ConversationSummary>
  deleteConversation?(id: string): Promise<void>
}
