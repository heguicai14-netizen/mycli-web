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

// ---------------- Agent message types ----------------

/** A piece of message content; MVP only uses text/tool_use/tool_result. */
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
  /** True while streaming; false once committed */
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

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  description: string
  /** JSON Schema describing the tool's input */
  inputSchema: Record<string, unknown>
  /** Where the tool's body actually runs */
  exec: 'content' | 'sw' | 'offscreen'
  execute(input: I, ctx: ToolExecContext): Promise<ToolResult<O>>
}

export interface ToolExecContext {
  conversationId: ConversationId
  /** Active tab id (the tab the user invoked agent on) */
  tabId: number | undefined
  /** RPC for tools to call out to content script / chrome.* via SW */
  rpc: ToolExecRpc
}

export interface ToolExecRpc {
  /** Send a DomOp to the target tab's content script and await the typed result */
  domOp(op: unknown, timeoutMs?: number): Promise<ToolResult>
  /** Invoke a chrome.* API via SW */
  chromeApi(method: string, args: unknown[]): Promise<ToolResult>
}
