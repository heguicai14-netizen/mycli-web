// 中央类型定义。Plan B 抽核之后唯一的 agent 类型来源。

export type Uuid = string

export type ConversationId = Uuid
export type MessageId = Uuid
export type ToolCallId = Uuid
export type ApprovalId = Uuid
export type SkillId = string

export type Role = 'user' | 'assistant' | 'tool' | 'system-synth'

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean; details?: unknown } }

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: ToolCallId; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: ToolCallId; content: string; is_error?: boolean }

export interface UserMessage {
  id: MessageId
  role: 'user'
  content: ContentPart[]
  createdAt: number
}

export interface AssistantMessage {
  id: MessageId
  role: 'assistant'
  content: ContentPart[]
  createdAt: number
  pending?: boolean
  stopReason?: 'end_turn' | 'tool_use' | 'max_iterations' | 'cancel' | 'error'
}

export interface ToolMessage {
  id: MessageId
  role: 'tool'
  toolCallId: ToolCallId
  content: string
  isError?: boolean
  createdAt: number
}

export type Message = UserMessage | AssistantMessage | ToolMessage

export interface ToolCall {
  id: ToolCallId
  name: string
  input: unknown
}

export interface ToolDefinition<I = unknown, O = unknown, ExtraCtx = Record<string, never>> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: I, ctx: ToolExecContext & ExtraCtx): Promise<ToolResult<O>>
}

export interface ToolExecContext {
  signal?: AbortSignal
}
