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

// ---------------- Offscreen ↔ Content (DOM ops) ----------------

const DomReadPage = Base.extend({
  kind: z.literal('dom/readPage'),
  tabId: z.number().int(),
  mode: z.enum(['text', 'markdown', 'html-simplified']),
})

const DomClick = Base.extend({
  kind: z.literal('dom/click'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string(), all: z.boolean().optional() }),
})

const DomType = Base.extend({
  kind: z.literal('dom/type'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string() }),
  value: z.string(),
})

const DomScreenshot = Base.extend({
  kind: z.literal('dom/screenshot'),
  tabId: z.number().int(),
})

export const DomOp = z.discriminatedUnion('kind', [
  DomReadPage,
  DomClick,
  DomType,
  DomScreenshot,
])
export type DomOp = z.infer<typeof DomOp>

// ---------------- Envelope ----------------

export const Envelope = z.object({
  direction: z.enum([
    'client->offscreen',
    'offscreen->client',
    'offscreen->content',
    'content->offscreen',
  ]),
  payload: z.union([ClientCmd, AgentEvent, DomOp]),
})
export type Envelope = z.infer<typeof Envelope>
