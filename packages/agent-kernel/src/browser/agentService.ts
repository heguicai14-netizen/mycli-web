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
import type { ToolDefinition } from '../core/types'
import { fetchGetTool } from '../core/tools/fetchGet'
import { compactMessages } from '../core/compactor'
import { estimateMessageTokens, estimateTokens } from '../core/tokenBudget'
import type { SettingsAdapter } from '../adapters/SettingsAdapter'
import type { MessageStoreAdapter, MessageRecord } from '../adapters/MessageStoreAdapter'
import type { ToolContextBuilder } from '../adapters/ToolContextBuilder'

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

  return {
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
      async function buildPriorHistory(): Promise<{
        chat: ChatMessage[]
        records: MessageRecord[]
      }> {
        if (ephemeral || !cid) return { chat: [], records: [] }
        const all = await deps.messageStore.list(cid)
        const eligible = all.filter((m) => !m.compacted && m.id !== userMsgId)
        const chat: ChatMessage[] = eligible.map((m) => ({
          role:
            m.role === 'system-synth'
              ? 'system'
              : (m.role as ChatMessage['role']),
          content:
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }))
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
        toolContext,
        toolMaxIterations: settings.toolMaxIterations,
        systemPrompt,
      })

      onAbortable?.(() => agent.cancel())

      const assistantCreatedAt = Date.now()
      const assistantMsgId = ephemeral
        ? crypto.randomUUID()
        : (
            await deps.messageStore.append({
              conversationId: cid!,
              role: 'assistant',
              content: '',
              pending: true,
            })
          ).id
      const assistantMsg = { id: assistantMsgId, createdAt: assistantCreatedAt }

      // Empty pending placeholder so UIs can anchor tool/start cards even when
      // the model calls a tool before producing any assistant text.
      deps.emit({
        id: crypto.randomUUID(),
        sessionId: cmd.sessionId,
        ts: Date.now(),
        kind: 'message/appended',
        message: {
          id: assistantMsg.id,
          role: 'assistant',
          content: '',
          createdAt: assistantMsg.createdAt,
          pending: true,
        },
      })

      try {
        for await (const ev of agent.send(cmd.text, {
          history: priorHistory,
        }) as AsyncIterable<CoreAgentEvent>) {
          if (ev.kind === 'message/streamChunk') {
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'message/streamChunk',
              messageId: assistantMsg.id,
              delta: ev.delta,
            })
          } else if (ev.kind === 'usage') {
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'message/usage',
              messageId: assistantMsg.id,
              input: ev.input,
              output: ev.output,
            })
          } else if (ev.kind === 'tool/start') {
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'tool/start',
              toolCall: ev.toolCall,
            })
          } else if (ev.kind === 'tool/end') {
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'tool/end',
              toolCallId: ev.toolCallId,
              result: ev.result,
            })
          } else if (ev.kind === 'done') {
            if (!ephemeral) {
              await deps.messageStore.update(assistantMsg.id, {
                content: ev.assistantText,
                pending: false,
              })
            }
            deps.emit({
              id: crypto.randomUUID(),
              sessionId: cmd.sessionId,
              ts: Date.now(),
              kind: 'message/appended',
              message: {
                id: assistantMsg.id,
                role: 'assistant',
                content: ev.assistantText,
                createdAt: assistantMsg.createdAt,
                pending: false,
              },
            })
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
