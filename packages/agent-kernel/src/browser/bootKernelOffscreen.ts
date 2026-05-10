// Offscreen-document side bootstrap for the kernel. Encapsulates the
// `sw-to-offscreen` port management, ClientCmd parsing, agentService wiring,
// runtime-error capture, and the chat/* command switch. Consumers replace
// their offscreen.ts body with a single call to bootKernelOffscreen() after
// running the chrome.* polyfill.

import { ClientCmd } from './rpc/protocol'
import { createAgentService, type AgentServiceDeps } from './agentService'
import type { SettingsAdapter } from '../adapters/SettingsAdapter'
import type { MessageStoreAdapter } from '../adapters/MessageStoreAdapter'
import type { ToolContextBuilder } from '../adapters/ToolContextBuilder'
import type { ToolDefinition } from '../core/types'

// Sentinel sessionId for runtime-wide events that don't belong to any chat
// session — same constant the SW-side hub uses for runtime/error fanout.
const SENTINEL_SESSION_ID = '00000000-0000-4000-8000-000000000000'

export interface BootKernelOffscreenOptions {
  settings: SettingsAdapter
  messageStore: MessageStoreAdapter
  toolContext: ToolContextBuilder
  tools: ToolDefinition<any, any, any>[]
  /** Override createAgent (tests inject fakes). */
  createAgent?: AgentServiceDeps['createAgent']
}

export function bootKernelOffscreen(opts: BootKernelOffscreenOptions): void {
  console.log(
    '[agent-kernel/offscreen] runtime booted at',
    new Date().toISOString(),
  )

  let swPort: chrome.runtime.Port | null = null
  const activeAborts = new Map<string, { abort: () => void }>()
  // Holds runtime/error events that fired before the SW port came up — they
  // need to reach content tabs once the connection is established.
  const pendingRuntimeErrors: any[] = []

  function emit(ev: any): void {
    swPort?.postMessage(ev)
  }

  function reportRuntimeError(message: string, stack?: string): void {
    const ev = {
      id: crypto.randomUUID(),
      sessionId: SENTINEL_SESSION_ID,
      ts: Date.now(),
      kind: 'runtime/error' as const,
      source: 'offscreen' as const,
      message,
      stack,
    }
    console.error('[agent-kernel/offscreen] runtime error:', message, stack ?? '')
    if (swPort) swPort.postMessage(ev)
    else pendingRuntimeErrors.push(ev)
  }

  ;(self as any).addEventListener?.('error', (e: any) => {
    reportRuntimeError(e?.message ?? 'uncaught error', e?.error?.stack)
  })
  ;(self as any).addEventListener?.('unhandledrejection', (e: any) => {
    const reason = e?.reason
    const message =
      typeof reason === 'string' ? reason : reason?.message ?? 'unhandled rejection'
    reportRuntimeError(message, reason?.stack)
  })

  const agentService = createAgentService({
    settings: opts.settings,
    emit,
    messageStore: opts.messageStore,
    toolContext: opts.toolContext,
    tools: opts.tools,
    createAgent: opts.createAgent,
  })

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sw-to-offscreen') return
    console.log('[agent-kernel/offscreen] SW connected')
    swPort = port
    while (pendingRuntimeErrors.length) port.postMessage(pendingRuntimeErrors.shift())
    port.onMessage.addListener((raw: any) => {
      void handleClientCmd(raw)
    })
    port.onDisconnect.addListener(() => {
      console.warn('[agent-kernel/offscreen] SW disconnected')
      swPort = null
      for (const [, ac] of activeAborts) ac.abort()
      activeAborts.clear()
    })
  })

  async function handleClientCmd(raw: unknown): Promise<void> {
    const parsed = ClientCmd.safeParse(raw)
    if (!parsed.success) {
      console.warn(
        '[agent-kernel/offscreen] ClientCmd schema_invalid:',
        parsed.error.message,
        'raw kind:',
        (raw as any)?.kind,
      )
      return
    }
    const cmd = parsed.data
    console.log(
      '[agent-kernel/offscreen] cmd received:',
      cmd.kind,
      'session',
      cmd.sessionId,
    )
    switch (cmd.kind) {
      case 'chat/send':
        void runChat(cmd)
        return
      case 'chat/cancel':
        for (const [, ac] of activeAborts) ac.abort()
        activeAborts.clear()
        return
      case 'chat/newConversation':
        // Default: messageStore.activeConversationId() lazy-creates on the
        // next turn. Consumers wanting explicit creation can wrap their
        // messageStore.
        return
      case 'chat/resubscribe':
        await pushSnapshot(cmd.sessionId, cmd.conversationId)
        return
      case 'ping':
        // Hub ack handles it; offscreen is a no-op so the SW just stays alive.
        return
      default:
        return
    }
  }

  async function runChat(cmd: {
    sessionId: string
    text: string
    system?: string
    tools?: string[]
    model?: string
    ephemeral?: boolean
  }): Promise<void> {
    await agentService.runTurn(cmd, (cancel) => {
      activeAborts.set(cmd.sessionId, { abort: cancel })
    })
    activeAborts.delete(cmd.sessionId)
  }

  async function pushSnapshot(
    sessionId: string,
    conversationId?: string,
  ): Promise<void> {
    const cid = conversationId ?? (await opts.messageStore.activeConversationId())
    const messages = await opts.messageStore.list(cid)
    emit({
      id: crypto.randomUUID(),
      sessionId,
      ts: Date.now(),
      kind: 'state/snapshot',
      conversation: {
        id: cid,
        // Generic title — consumers wanting custom titles can wrap their
        // messageStore. The chat UI doesn't display this prominently.
        title: 'Conversation',
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          pending: m.pending,
        })),
      },
    })
  }
}
