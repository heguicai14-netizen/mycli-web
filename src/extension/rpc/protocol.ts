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

export const AgentEvent = z.discriminatedUnion('kind', [
  MessageAppended,
  MessageStreamChunk,
  ToolStart,
  ToolEnd,
  SubAgentSpawned,
  SubAgentUpdate,
  ApprovalRequested,
  StateSnapshot,
  PingEvt,
  CommandAck,
  FatalError,
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
