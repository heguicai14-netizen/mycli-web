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
  type AgentSession as CoreAgentSession,
  type ChatMessage,
  type AgentEvent as CoreAgentEvent,
  type ToolDefinition,
} from 'agent-kernel'
import { fetchGetTool } from 'agent-kernel'
import { extensionTools, type ExtensionToolCtx } from '@ext-tools'
import { useSkillTool, readSkillFileTool } from '@ext-skills'
import type { Settings } from './storage/settings'

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

interface AppendMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

interface AppendedMessage {
  id: string
  createdAt: number
}

interface HistoryRow {
  id: string
  role: string
  content: unknown
  compacted?: boolean
}

export interface AgentServiceDeps {
  loadSettings: () => Promise<Settings>
  /** Posts a wire event to whoever is consuming agent output (in production:
   *  the SW port back to clients via the hub). */
  emit: (ev: any) => void
  appendMessage: (msg: AppendMessageInput) => Promise<AppendedMessage>
  listMessagesByConversation: (cid: string) => Promise<HistoryRow[]>
  updateMessage: (
    id: string,
    patch: { content?: string; pending?: boolean },
  ) => Promise<void>
  activeConversationId: () => Promise<string>
  /** Build the per-turn ToolExecContext (tabId, rpc, etc). cid is undefined
   *  for ephemeral turns. */
  buildToolContext: (cid: string | undefined) => Promise<ExtensionToolCtx>
  /** Default tool list, before per-turn allowlist filter. */
  tools?: ToolDefinition<any, any, any>[]
  /** Override createAgent (tests use this to inject a fake LLM client). */
  createAgent?: <ExtraCtx>(
    opts: CreateAgentOptions<ExtraCtx>,
  ) => CoreAgentSession<ExtraCtx>
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
  const allTools = deps.tools ?? [
    fetchGetTool,
    ...extensionTools,
    useSkillTool,
    readSkillFileTool,
  ]
  const createAgent = deps.createAgent ?? defaultCreateAgent

  return {
    async runTurn(cmd, onAbortable) {
      console.log(
        '[mycli-web/agent] runTurn start, text:',
        cmd.text,
        'ephemeral:',
        !!cmd.ephemeral,
      )
      const settings = await deps.loadSettings()
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
      const cid = ephemeral ? null : await deps.activeConversationId()

      const userTs = Date.now()
      const userMsgId = ephemeral
        ? crypto.randomUUID()
        : (
            await deps.appendMessage({
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

      let priorHistory: ChatMessage[] = []
      if (!ephemeral) {
        const allHistory = await deps.listMessagesByConversation(cid!)
        priorHistory = allHistory
          .filter((m) => !m.compacted)
          .filter((m) => m.id !== userMsgId)
          .map((m) => ({
            role:
              m.role === 'system-synth'
                ? 'system'
                : (m.role as ChatMessage['role']),
            content:
              typeof m.content === 'string'
                ? m.content
                : JSON.stringify(m.content),
          }))
      }

      const toolContext = await deps.buildToolContext(cid ?? undefined)
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
            await deps.appendMessage({
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
              await deps.updateMessage(assistantMsg.id, {
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
