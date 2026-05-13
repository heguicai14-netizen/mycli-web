// Agent orchestration extracted from offscreen.ts. The pure-ish dependency
// surface (no chrome.*, no IndexedDB, no globals) makes this directly
// unit-testable — tests inject stub deps + a fake createAgent and assert
// that the right wire events get emitted in the right order.
//
// offscreen.ts is now a thin assembly layer that wires the real chrome /
// IDB / hub-port implementations into createAgentService(...).

import {
  createAgent as defaultCreateAgent,
  type CreateAgentOptions,
} from '../core/createAgent'
import type { AgentSession as CoreAgentSession } from '../core/AgentSession'
import type { ChatMessage } from '../core/OpenAICompatibleClient'
import { OpenAICompatibleClient } from '../core/OpenAICompatibleClient'
import type { AgentEvent as CoreAgentEvent } from '../core/protocol'
import type { ToolDefinition, ToolCall } from '../core/types'
import { fetchGetTool } from '../core/tools/fetchGet'
import { compactMessages } from '../core/compactor'
import { truncateForLLM } from '../core/truncate'
import { estimateMessageTokens, estimateTokens } from '../core/tokenBudget'
import type { SettingsAdapter } from '../adapters/SettingsAdapter'
import type { MessageStoreAdapter, MessageRecord } from '../adapters/MessageStoreAdapter'
import type { ToolContextBuilder } from '../adapters/ToolContextBuilder'
import type { TodoStoreAdapter, TodoItem } from '../adapters/TodoStoreAdapter'
import {
  ApprovalCoordinator,
  type ApprovalAdapter,
  type ApprovalContext,
} from '../core/approval'

export type { Settings } from '../adapters/SettingsAdapter'

export interface RunTurnInput {
  sessionId: string
  text: string
  /** Per-request override of the system prompt. */
  system?: string
  /** Allowlist of tool names. Undefined = all default tools. */
  tools?: string[]
  /** Override LLM model id. */
  model?: string
  /** Skip IndexedDB persistence and history loading. */
  ephemeral?: boolean
}

export interface AgentServiceDeps {
  settings: SettingsAdapter
  /** Posts a wire event to whoever is consuming agent output (in production:
   *  the SW port back to clients via the hub). */
  emit: (ev: any) => void
  /** Persistence + active-conversation source for chat turns. Kernel ships a
   *  default IDB-backed implementation via createIdbMessageStore(). */
  messageStore: MessageStoreAdapter
  /** Build the per-turn ToolExecContext (tabId, rpc, etc). cid is undefined
   *  for ephemeral turns. The returned context is passed verbatim as the
   *  agent's ExtraCtx — kernel doesn't care about its shape. */
  toolContext: ToolContextBuilder
  /** Default tool list, before per-turn allowlist filter. */
  tools?: ToolDefinition<any, any, any>[]
  /** Override createAgent (tests use this to inject a fake LLM client). */
  createAgent?: <ExtraCtx>(
    opts: CreateAgentOptions<ExtraCtx>,
  ) => CoreAgentSession<ExtraCtx>
  /** Override the compactor used for auto-compaction summaries. Tests inject
   *  this to avoid spinning up a real OpenAI-compatible client. */
  compact?: (input: {
    messages: ChatMessage[]
    apiKey: string
    baseUrl: string
    model: string
  }) => Promise<string>
  /** Adapter for approval decisions. If provided, agentService constructs an
   *  ApprovalCoordinator and wires it into each QueryEngine. */
  approvalAdapter?: ApprovalAdapter
  /** Override the coordinator directly (used by tests). When provided,
   *  agentService uses this instance and ignores approvalAdapter. */
  approvalCoordinator?: ApprovalCoordinator
  /** Build ApprovalContext for each tool call. */
  buildApprovalContext?: (call: ToolCall) => ApprovalContext | Promise<ApprovalContext>
  /** Per-conversation todo store. Required for todoWriteTool to function. */
  todoStore?: TodoStoreAdapter
}

export interface AgentService {
  /** Run one turn end-to-end: emit wire events, persist if not ephemeral,
   *  surface tool calls and the final assistant message. The optional
   *  onAbortable callback is invoked once with a cancel function the caller
   *  can wire into a session-cancel registry. */
  runTurn(
    input: RunTurnInput,
    onAbortable?: (cancel: () => void) => void,
  ): Promise<void>
  /** Dispatch a non-turn ClientCmd (e.g. approval/reply, chat/loadConversation).
   *  Unrecognised kinds are silently ignored. */
  handleCommand?(cmd: { kind: string; [k: string]: unknown }): void | Promise<void>
}

export function createAgentService(deps: AgentServiceDeps): AgentService {
  // Default tool list intentionally minimal — only the kernel-shipped
  // fetchGetTool. Consumers wanting in-page DOM/extension tools or skills
  // pass an explicit `tools: [...]` list.
  const allTools = deps.tools ?? [fetchGetTool]
  const createAgent = deps.createAgent ?? defaultCreateAgent
  const compactImpl =
    deps.compact ??
    (async ({ messages, apiKey, baseUrl, model }) => {
      const client = new OpenAICompatibleClient({ apiKey, baseUrl, model })
      return compactMessages({ messages, client })
    })

  // Construct (or accept override of) the ApprovalCoordinator once per service
  // instance so sticky decisions persist across turns within the same session.
  const coordinator: ApprovalCoordinator | undefined =
    deps.approvalCoordinator ??
    (deps.approvalAdapter
      ? new ApprovalCoordinator({
          adapter: deps.approvalAdapter,
          emit: (e) => {
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: e.sessionId,
              ts: Date.now(),
              kind: 'approval/requested',
              approval: {
                id: e.approvalId,
                tool: e.req.tool,
                argsSummary: e.summary,
                origin:
                  typeof e.req.ctx?.origin === 'string'
                    ? e.req.ctx.origin
                    : undefined,
              },
            })
          },
        })
      : undefined)

  return {
    async handleCommand(cmd) {
      if (cmd.kind === 'approval/reply') {
        if (coordinator) {
          coordinator.resolve(
            cmd.approvalId as string,
            cmd.decision as any,
          )
        } else {
          console.warn(
            '[agentService] approval/reply received but no coordinator configured',
          )
        }
      } else if (cmd.kind === 'chat/loadConversation') {
        if (deps.todoStore && cmd.conversationId) {
          try {
            const items = await deps.todoStore.list(cmd.conversationId as string)
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId as string,
              ts: Date.now(),
              kind: 'todo/updated',
              conversationId: cmd.conversationId as string,
              items,
            })
          } catch (e) {
            console.warn('[agentService] todoStore.list failed during loadConversation', e)
          }
        }
      }
    },

    async runTurn(cmd, onAbortable) {
      console.log(
        '[mycli-web/agent] runTurn start, text:',
        cmd.text,
        'ephemeral:',
        !!cmd.ephemeral,
      )
      const settings = await deps.settings.load()
      console.log(
        '[mycli-web/agent] settings loaded; apiKey set:',
        !!settings.apiKey,
        'baseUrl:',
        settings.baseUrl,
        'model:',
        cmd.model ?? settings.model,
      )

      if (!settings.apiKey) {
        deps.emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'fatalError',
          code: 'no_api_key',
          message: 'Configure API key in extension options first.',
        })
        return
      }

      const ephemeral = !!cmd.ephemeral
      const cid = ephemeral ? null : await deps.messageStore.activeConversationId()

      const userTs = Date.now()
      const userMsgId = ephemeral
        ? crypto.randomUUID()
        : (
            await deps.messageStore.append({
              conversationId: cid!,
              role: 'user',
              content: cmd.text,
            })
          ).id
      deps.emit({
        id: crypto.randomUUID(),
        sessionId: cmd.sessionId,
        ts: userTs,
        kind: 'message/appended',
        message: {
          id: userMsgId,
          role: 'user',
          content: cmd.text,
          createdAt: userTs,
        },
      })

      // Build (or rebuild after compaction) the prior history sent to the LLM.
      // Tracks both the chat-shaped messages and the source records so we can
      // map a slice back to record ids for markCompacted().
      //
      // Assistant rows with `toolCalls` are mapped back to OpenAI's `tool_calls`
      // field; tool rows carry their `tool_call_id` so the LLM can pair them.
      // Without this shape, the API rejects the request when a tool message
      // appears without a matching assistant message containing its id.
      async function buildPriorHistory(): Promise<{
        chat: ChatMessage[]
        records: MessageRecord[]
      }> {
        if (ephemeral || !cid) return { chat: [], records: [] }
        const all = await deps.messageStore.list(cid)
        const eligible = all.filter((m) => !m.compacted && m.id !== userMsgId)
        const chat: ChatMessage[] = eligible.map((m) => {
          const role: ChatMessage['role'] =
            m.role === 'system-synth'
              ? 'system'
              : (m.role as ChatMessage['role'])
          const content =
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          const msg: ChatMessage = { role, content }
          if (role === 'assistant' && m.toolCalls && m.toolCalls.length) {
            msg.tool_calls = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments:
                  typeof tc.input === 'string'
                    ? tc.input
                    : JSON.stringify(tc.input ?? {}),
              },
            }))
          }
          if (role === 'tool' && m.toolCallId) {
            msg.tool_call_id = m.toolCallId
            // Truncate the LLM-facing copy of the tool result so a single
            // bloated past tool call doesn't keep eating tokens on every
            // subsequent turn. The original full content stays in IDB.
            msg.content = truncateForLLM(content, settings.toolMaxOutputChars)
          }
          return msg
        })
        return { chat, records: eligible }
      }

      let { chat: priorHistory, records: priorRecords } = await buildPriorHistory()

      // ---------- Auto-compaction phase ----------
      const ac = settings.autoCompact
      const canCompact =
        !!ac?.enabled &&
        !ephemeral &&
        !!cid &&
        typeof deps.messageStore.markCompacted === 'function' &&
        priorRecords.length > (ac?.keepRecentMessages ?? 0)

      if (canCompact && ac) {
        const threshold = Math.floor(
          (ac.modelContextWindow * ac.thresholdPercent) / 100,
        )
        const beforeTokens =
          priorHistory.reduce((acc, m) => acc + estimateMessageTokens(m), 0) +
          estimateTokens(cmd.text) +
          estimateTokens(cmd.system ?? settings.systemPromptAddendum ?? '')

        if (beforeTokens > threshold) {
          const headRecords = priorRecords.slice(
            0,
            priorRecords.length - ac.keepRecentMessages,
          )
          const headChat = priorHistory.slice(0, headRecords.length)

          deps.emit({
            id: crypto.randomUUID(),
            sessionId: cmd.sessionId,
            ts: Date.now(),
            kind: 'compact/started',
            messagesToCompact: headRecords.length,
            estimatedTokens: beforeTokens,
            threshold,
          })

          // Cancellation during compaction isn't user-cancellable in v1 — the
          // OpenAI client's fetchTimeoutMs caps the wait, so users see at most
          // ~60s before the orchestrator either succeeds or emits compact/failed.
          try {
            const summary = await compactImpl({
              messages: headChat,
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: cmd.model ?? settings.model,
            })

            const summaryRow = await deps.messageStore.append({
              conversationId: cid!,
              role: 'system-synth',
              content: summary,
            })
            await deps.messageStore.markCompacted!(
              headRecords.map((r) => r.id),
            )

            // Surface the synthesized summary in the UI as an appended message
            // so the user can see what was compacted in.
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'message/appended',
              message: {
                id: summaryRow.id,
                role: 'system-synth',
                content: summary,
                createdAt: summaryRow.createdAt,
              },
            })

            // Rebuild history; the new system-synth row is now eligible (not
            // compacted) and will appear at the head as a system message.
            const rebuilt = await buildPriorHistory()
            priorHistory = rebuilt.chat
            priorRecords = rebuilt.records

            const afterTokens =
              priorHistory.reduce(
                (acc, m) => acc + estimateMessageTokens(m),
                0,
              ) + estimateTokens(cmd.text)

            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'compact/completed',
              messagesCompacted: headRecords.length,
              beforeTokens,
              afterTokens,
              summaryMessageId: summaryRow.id,
            })
          } catch (e: any) {
            // Compaction is best-effort: any failure (network, abort,
            // adapter error) degrades to "skip this turn, use full history".
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'compact/failed',
              reason: e?.message ?? String(e),
            })
          }
        }
      }
      // ---------- end auto-compaction ----------

      const toolContext = await deps.toolContext.build(cid ?? undefined)
      const turnId = crypto.randomUUID()
      // Augment with todo + subagent fields. emitSubagentEvent forwards
      // sub-agent lifecycle events through deps.emit with the wire envelope.
      const fullCtx = {
        ...toolContext,
        todoStore: deps.todoStore,
        conversationId: cid ?? undefined,
        turnId,
        emitSubagentEvent: (ev: any) => {
          deps.emit({
            id: crypto.randomUUID(),
            sessionId: cmd.sessionId,
            ts: Date.now(),
            ...ev,
          })
        },
      }
      const filteredTools = cmd.tools
        ? allTools.filter((t) => cmd.tools!.includes(t.name))
        : allTools
      const systemPrompt =
        cmd.system ?? (settings.systemPromptAddendum || undefined)
      const model = cmd.model ?? settings.model

      const agent = createAgent({
        llm: {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model,
        },
        tools: filteredTools,
        toolContext: fullCtx,
        toolMaxIterations: settings.toolMaxIterations,
        systemPrompt,
        toolMaxOutputChars: settings.toolMaxOutputChars,
        approvalCoordinator: coordinator,
        sessionId: cmd.sessionId,
        buildApprovalContext: deps.buildApprovalContext,
      })

      onAbortable?.(() => {
        agent.cancel()
        coordinator?.cancelSession(cmd.sessionId, 'turn cancelled')
      })

      // Per-iteration row management. We append assistant rows lazily — the
      // first streamChunk of an iteration triggers an append; the iter's
      // assistant/iter event finalizes that row with the iteration's tool
      // calls. Empty-text iterations (the LLM only produced tool_calls) get a
      // row at iter time so the OpenAI replay shape is correct on the next
      // turn (a tool message must immediately follow the assistant message
      // that holds the matching tool_calls).
      let currentPendingId: string | null = null
      let currentPendingCreatedAt = 0
      let lastAssistantId: string | null = null
      // Tracks in-flight tool call names by callId so tool/end can look up
      // which tool produced a given result (tool/end itself doesn't carry the
      // tool name, only the callId).
      const inFlightTools = new Map<string, string>()

      async function openAssistantRow(): Promise<{ id: string; createdAt: number }> {
        const createdAt = Date.now()
        const id = ephemeral
          ? crypto.randomUUID()
          : (
              await deps.messageStore.append({
                conversationId: cid!,
                role: 'assistant',
                content: '',
                pending: true,
              })
            ).id
        currentPendingId = id
        currentPendingCreatedAt = createdAt
        lastAssistantId = id
        deps.emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/appended',
          message: { id, role: 'assistant', content: '', createdAt, pending: true },
        })
        return { id, createdAt }
      }

      async function finalizeAssistantRow(
        text: string,
        toolCalls: Array<{ id: string; name: string; input?: unknown }>,
      ): Promise<void> {
        // If the iteration produced 0 streamChunks (tool-call-only iter), open
        // a row now so the iteration is still represented in storage.
        if (!currentPendingId) await openAssistantRow()
        const id = currentPendingId!
        const createdAt = currentPendingCreatedAt
        if (!ephemeral) {
          await deps.messageStore.update(id, {
            content: text,
            pending: false,
            ...(toolCalls.length ? { toolCalls } : {}),
          })
        }
        deps.emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/appended',
          message: {
            id,
            role: 'assistant',
            content: text,
            createdAt,
            pending: false,
          },
        })
        currentPendingId = null
      }

      try {
        for await (const ev of agent.send(cmd.text, {
          history: priorHistory,
        }) as AsyncIterable<CoreAgentEvent>) {
          if (ev.kind === 'message/streamChunk') {
            if (!currentPendingId) await openAssistantRow()
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'message/streamChunk',
              messageId: currentPendingId!,
              delta: ev.delta,
            })
          } else if (ev.kind === 'assistant/iter') {
            await finalizeAssistantRow(ev.text, ev.toolCalls)
          } else if (ev.kind === 'usage') {
            // Anchor on the just-finalized assistant row so the UI's context
            // bar updates against the iteration that actually consumed those
            // tokens. lastAssistantId is set by openAssistantRow().
            if (lastAssistantId) {
              deps.emit({
                id: crypto.randomUUID(),
                sessionId: cmd.sessionId,
                ts: Date.now(),
                kind: 'message/usage',
                messageId: lastAssistantId,
                input: ev.input,
                output: ev.output,
                ...(ev.cached !== undefined ? { cached: ev.cached } : {}),
              })
            }
          } else if (ev.kind === 'tool/start') {
            inFlightTools.set(ev.toolCall.id, ev.toolCall.tool)
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'tool/start',
              toolCall: ev.toolCall,
            })
          } else if (ev.kind === 'tool/end') {
            const toolName = inFlightTools.get(ev.toolCallId)
            inFlightTools.delete(ev.toolCallId)
            // Persist the tool result as its own row so future turns can
            // replay it back to the LLM in canonical OpenAI shape.
            if (!ephemeral) {
              const toolRow = await deps.messageStore.append({
                conversationId: cid!,
                role: 'tool',
                content: ev.result.content ?? '',
                toolCallId: ev.toolCallId,
              })
              deps.emit({
                id: crypto.randomUUID(),
                sessionId: cmd.sessionId,
                ts: Date.now(),
                kind: 'message/appended',
                message: {
                  id: toolRow.id,
                  role: 'tool',
                  content: ev.result.content ?? '',
                  createdAt: toolRow.createdAt,
                },
              })
            }
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'tool/end',
              toolCallId: ev.toolCallId,
              result: ev.result,
            })
            // Surface todoWrite completion as a dedicated wire event so the
            // UI can rebuild from the canonical items list without having to
            // parse tool results.
            if (toolName === 'todoWrite' && cid && ev.result?.ok) {
              let items: TodoItem[] = []
              try {
                const parsed = JSON.parse(ev.result.content) as {
                  items?: TodoItem[]
                }
                items = parsed?.items ?? []
              } catch {
                // If parse fails, skip emit
              }
              deps.emit({
                id: crypto.randomUUID(),
                sessionId: cmd.sessionId,
                ts: Date.now(),
                kind: 'todo/updated',
                conversationId: cid,
                items,
              })
            }
          } else if (ev.kind === 'done') {
            // Defensive: if a final pending row somehow survived (no
            // assistant/iter ever closed it — shouldn't happen with the
            // current QueryEngine, but error paths are weird), close it now
            // with the accumulated assistantText.
            if (currentPendingId) {
              await finalizeAssistantRow(ev.assistantText, [])
            }
          }
        }
      } catch (e: any) {
        deps.emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'fatalError',
          code: 'engine_error',
          message: e?.message ?? String(e),
        })
      }
    },
  }
}
