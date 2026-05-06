import { z } from 'zod'

// agent-core 内部事件流。无 envelope（id/sessionId/ts）、无 messageId。
// 消费方（extension offscreen）拿到后再包 envelope 发到 wire。

const StreamChunk = z.object({
  kind: z.literal('message/streamChunk'),
  delta: z.string(),
})

const ToolStart = z.object({
  kind: z.literal('tool/start'),
  toolCall: z.object({
    id: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
})

const ToolEnd = z.object({
  kind: z.literal('tool/end'),
  toolCallId: z.string(),
  result: z.object({
    ok: z.boolean(),
    content: z.string(),
  }),
})

const Done = z.object({
  kind: z.literal('done'),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_iterations', 'cancel', 'error']),
  /** 完整 assistant 文本（done 时累计的全文）。给消费方持久化用。 */
  assistantText: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

const FatalError = z.object({
  kind: z.literal('fatalError'),
  code: z.string(),
  message: z.string(),
})

export const AgentEvent = z.discriminatedUnion('kind', [
  StreamChunk,
  ToolStart,
  ToolEnd,
  Done,
  FatalError,
])
export type AgentEvent = z.infer<typeof AgentEvent>
