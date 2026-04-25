// 跨进程广泛复用的基础类型。Plan B 会往这里补 AssistantMessage、ToolCall 等 agent 专属类型。

export type Uuid = string

export type ConversationId = Uuid
export type MessageId = Uuid
export type ToolCallId = Uuid
export type ApprovalId = Uuid
export type SkillId = string // skill name@version 组合，非 uuid

export type Role = 'user' | 'assistant' | 'tool' | 'system-synth'

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean; details?: unknown } }
