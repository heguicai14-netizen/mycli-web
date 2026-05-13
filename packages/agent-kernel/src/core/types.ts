// 中央类型定义。Plan B 抽核之后唯一的 agent 类型来源。

import type { TodoStoreAdapter } from '../adapters/TodoStoreAdapter'

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
  /** When true, the kernel will gate this tool's calls through ApprovalCoordinator. */
  requiresApproval?: boolean
  /** Optional human-readable summary of args for the approval dialog.
   *  Default: JSON.stringify(args).slice(0, 200). */
  summarizeArgs?: (input: I) => string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** Branded uuid identifying a single sub-agent run. */
export type SubagentId = string & { readonly __brand: 'SubagentId' }

/** Forward declaration — full schema lives in core/protocol.ts. The execution
 *  context only needs the call signature, not the type body. */
export type SubagentEventInput = {
  kind:
    | 'subagent/started'
    | 'subagent/message'
    | 'subagent/tool_call'
    | 'subagent/tool_end'
    | 'subagent/finished'
  [k: string]: unknown
}

export interface ToolExecContext {
  signal?: AbortSignal
  /** Per-conversation todo store. Injected by agentService for tools that need it. */
  todoStore?: TodoStoreAdapter
  /** Active conversation id. Undefined for ephemeral turns. */
  conversationId?: ConversationId
  /** Stable id for the current main-agent turn. agentService generates one per
   *  runTurn. Sub-agents inherit (and override) via Task tool spawn. */
  turnId?: string
  /** Id of the in-flight ToolCall this execution corresponds to. Populated by
   *  AgentSession's executeTool closure. */
  callId?: string
  /** Present only when the current tool call is happening inside a sub-agent. */
  subagentId?: SubagentId
  /** Out-of-band emitter for sub-agent lifecycle events. Populated by
   *  agentService; tools that don't spawn sub-agents ignore this. */
  emitSubagentEvent?: (ev: SubagentEventInput) => void
}
