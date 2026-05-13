import { z } from 'zod'

export const Uuid = z.string().uuid()

const Base = z.object({
  id: Uuid,
  sessionId: Uuid,
  ts: z.number().int().nonnegative(),
})

// ---------------- Client → Offscreen ----------------

const ChatSend = Base.extend({
  kind: z.literal('chat/send'),
  text: z.string().min(1),
  attachments: z.array(z.unknown()).optional(),
  // Per-request overrides — undefined means "fall back to extension settings".
  // `tools` is a name allowlist; e.g. ['readPage'] runs the agent with only
  // that tool exposed to the LLM. `ephemeral` skips IndexedDB persistence so
  // the call doesn't pollute conversation history (intended for one-shot
  // consumers like a right-click menu or a settings test button).
  system: z.string().optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  ephemeral: z.boolean().optional(),
})

const ChatCancel = Base.extend({
  kind: z.literal('chat/cancel'),
})

const ChatNewConversation = Base.extend({
  kind: z.literal('chat/newConversation'),
  title: z.string().optional(),
})

const ChatLoadConversation = Base.extend({
  kind: z.literal('chat/loadConversation'),
  conversationId: Uuid,
})

const ChatListConversations = Base.extend({
  kind: z.literal('chat/listConversations'),
})

const ChatDeleteConversation = Base.extend({
  kind: z.literal('chat/deleteConversation'),
  conversationId: Uuid,
})

const ChatResubscribe = Base.extend({
  kind: z.literal('chat/resubscribe'),
  conversationId: Uuid.optional(),
})

const ApprovalReply = Base.extend({
  kind: z.literal('approval/reply'),
  approvalId: Uuid,
  decision: z.enum(['once', 'session', 'always', 'deny']),
})

const SkillSetEnabled = Base.extend({
  kind: z.literal('skill/setEnabled'),
  skillId: z.string(),
  enabled: z.boolean(),
})

const SkillInstall = Base.extend({
  kind: z.literal('skill/install'),
  package: z.unknown(),
})

const PingCmd = Base.extend({
  kind: z.literal('ping'),
})

export const ClientCmd = z.discriminatedUnion('kind', [
  ChatSend,
  ChatCancel,
  ChatNewConversation,
  ChatLoadConversation,
  ChatListConversations,
  ChatDeleteConversation,
  ChatResubscribe,
  ApprovalReply,
  SkillSetEnabled,
  SkillInstall,
  PingCmd,
])
export type ClientCmd = z.infer<typeof ClientCmd>

// ---------------- Offscreen → Client ----------------

const MessageLike = z.object({
  id: Uuid,
  role: z.enum(['user', 'assistant', 'tool', 'system-synth']),
  content: z.unknown(),
  createdAt: z.number(),
  /**
   * True while the assistant message is still being filled (placeholder before
   * stream starts, or mid-stream). False/absent on terminal messages. Used by
   * the UI to decide whether to keep showing busy state.
   */
  pending: z.boolean().optional(),
})

const MessageAppended = Base.extend({
  kind: z.literal('message/appended'),
  message: MessageLike,
})

const MessageStreamChunk = Base.extend({
  kind: z.literal('message/streamChunk'),
  messageId: Uuid,
  delta: z.string(),
})

// Per-iteration LLM token usage tied to the assistant message currently being
// built. UI consumers accumulate across events for a turn-level total.
const MessageUsage = Base.extend({
  kind: z.literal('message/usage'),
  messageId: Uuid,
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative().optional(),
})

// Auto-compaction wire events. Emitted by agentService when the conversation
// history exceeds the configured threshold and a summarization is in flight.
const CompactStarted = Base.extend({
  kind: z.literal('compact/started'),
  messagesToCompact: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
})

const CompactCompleted = Base.extend({
  kind: z.literal('compact/completed'),
  messagesCompacted: z.number().int().nonnegative(),
  beforeTokens: z.number().int().nonnegative(),
  afterTokens: z.number().int().nonnegative(),
  summaryMessageId: Uuid,
})

const CompactFailed = Base.extend({
  kind: z.literal('compact/failed'),
  reason: z.string(),
})

const ToolStart = Base.extend({
  kind: z.literal('tool/start'),
  toolCall: z.object({
    id: Uuid,
    tool: z.string(),
    args: z.unknown(),
  }),
})

const ToolEnd = Base.extend({
  kind: z.literal('tool/end'),
  toolCallId: Uuid,
  result: z.object({
    ok: z.boolean(),
  }).passthrough(),
})

const SubAgentSpawned = Base.extend({
  kind: z.literal('subAgent/spawned'),
  parent: Uuid,
  child: Uuid,
  reason: z.string(),
})

const SubAgentUpdate = Base.extend({
  kind: z.literal('subAgent/update'),
  child: Uuid,
  message: MessageLike,
})

const ApprovalRequested = Base.extend({
  kind: z.literal('approval/requested'),
  approval: z.object({
    id: Uuid,
    tool: z.string(),
    argsSummary: z.string(),
    origin: z.string().optional(),
  }),
})

const StateSnapshot = Base.extend({
  kind: z.literal('state/snapshot'),
  conversation: z.object({
    id: Uuid,
    title: z.string(),
    messages: z.array(MessageLike),
  }),
})

// Snapshot of all conversations + which one is currently active. Emitted in
// response to chat/listConversations and after any mutating cmd
// (newConversation / deleteConversation / loadConversation) so the UI list
// stays in sync with the kernel's view.
const ConversationsList = Base.extend({
  kind: z.literal('conversations/list'),
  activeId: Uuid,
  conversations: z.array(
    z.object({
      id: Uuid,
      title: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
  ),
})

const PingEvt = Base.extend({
  kind: z.literal('pong'),
})

const CommandAck = Base.extend({
  kind: z.literal('command/ack'),
  correlationId: Uuid,
  ok: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

const FatalError = Base.extend({
  kind: z.literal('fatalError'),
  code: z.string(),
  message: z.string(),
})

// Cross-context error report. Surfaces uncaught errors / unhandled rejections
// from SW or offscreen contexts to the content tab so devs can see them in
// F12 without opening separate DevTools windows. Not session-scoped; sessionId
// in Base is set to a sentinel and is ignored by the content handler.
const RuntimeError = Base.extend({
  kind: z.literal('runtime/error'),
  source: z.enum(['sw', 'offscreen']),
  message: z.string(),
  stack: z.string().optional(),
})

const TodoUpdated = Base.extend({
  kind: z.literal('todo/updated'),
  conversationId: Uuid,
  items: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed']),
      description: z.string().optional(),
      activeForm: z.string().optional(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
    }),
  ),
})

export const AgentEvent = z.discriminatedUnion('kind', [
  MessageAppended,
  MessageStreamChunk,
  MessageUsage,
  ToolStart,
  ToolEnd,
  SubAgentSpawned,
  SubAgentUpdate,
  ApprovalRequested,
  StateSnapshot,
  ConversationsList,
  TodoUpdated,
  PingEvt,
  CommandAck,
  FatalError,
  RuntimeError,
  CompactStarted,
  CompactCompleted,
  CompactFailed,
])
export type AgentEvent = z.infer<typeof AgentEvent>

// ---------------- Envelope ----------------

export const Envelope = z.object({
  direction: z.enum([
    'client->offscreen',
    'offscreen->client',
    'offscreen->content',
    'content->offscreen',
  ]),
  payload: z.union([ClientCmd, AgentEvent]),
})
export type Envelope = z.infer<typeof Envelope>
