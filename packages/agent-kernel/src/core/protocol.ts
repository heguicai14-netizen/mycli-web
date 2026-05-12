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

// Per-iteration token usage from the LLM. Emitted once per assistant turn that
// reports a usage object (some endpoints omit it). Cumulative aggregation is
// the consumer's responsibility — the kernel only forwards what the client
// observed in this iteration.
const Usage = z.object({
  kind: z.literal('usage'),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative().optional(),
})

// Per-iteration assistant message boundary. Each LLM completion within a
// multi-iteration turn yields one of these so consumers can persist a
// dedicated assistant row (with the iteration's tool calls) before the
// next iteration starts.
const AssistantIter = z.object({
  kind: z.literal('assistant/iter'),
  text: z.string(),
  toolCalls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    }),
  ),
})

// Auto-compaction lifecycle. Emitted by the orchestrator (not QueryEngine) when
// the history exceeds the configured threshold and a summarization pass starts /
// finishes. UI consumers use these to render a "Compacting…" status banner.
const CompactStarted = z.object({
  kind: z.literal('compact/started'),
  messagesToCompact: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
})

const CompactCompleted = z.object({
  kind: z.literal('compact/completed'),
  messagesCompacted: z.number().int().nonnegative(),
  beforeTokens: z.number().int().nonnegative(),
  afterTokens: z.number().int().nonnegative(),
})

const CompactFailed = z.object({
  kind: z.literal('compact/failed'),
  reason: z.string(),
})

export const AgentEvent = z.discriminatedUnion('kind', [
  StreamChunk,
  ToolStart,
  ToolEnd,
  Done,
  FatalError,
  Usage,
  AssistantIter,
  CompactStarted,
  CompactCompleted,
  CompactFailed,
])
export type AgentEvent = z.infer<typeof AgentEvent>
