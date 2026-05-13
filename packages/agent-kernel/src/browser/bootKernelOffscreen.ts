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
import type { ToolDefinition, ToolCall } from '../core/types'
import type { ApprovalAdapter, ApprovalContext } from '../core/approval'
import type { TodoStoreAdapter } from '../adapters/TodoStoreAdapter'
import { createIdbTodoStore } from './storage/createIdbTodoStore'
import { openDb } from './storage/db'
import { todoWriteTool } from '../core/tools/todoWrite'

// Sentinel sessionId for runtime-wide events that don't belong to any chat
// session — same constant the SW-side hub uses for runtime/error fanout.
const SENTINEL_SESSION_ID = '00000000-0000-4000-8000-000000000000'

export interface BootKernelOffscreenOptions {
  settings: SettingsAdapter
  messageStore: MessageStoreAdapter
  toolContext: ToolContextBuilder
  tools?: ToolDefinition<any, any, any>[]
  /** Override createAgent (tests inject fakes). */
  createAgent?: AgentServiceDeps['createAgent']
  approvalAdapter?: ApprovalAdapter
  buildApprovalContext?: (call: ToolCall) => ApprovalContext | Promise<ApprovalContext>
  /** Per-conversation todo store. Defaults to a lazy IDB-backed adapter
   *  using the kernel's IDB. Pass null to fully disable todo support —
   *  both the store and the todoWriteTool registration are skipped, so
   *  the LLM never sees the tool. */
  todoStore?: TodoStoreAdapter | null
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

  // Resolve effective todoStore:
  //   undefined → lazy-init default IDB store (opened on first use)
  //   null      → explicitly disabled, no store passed to agentService
  //   adapter   → consumer-supplied store, used as-is
  const resolvedTodoStore: TodoStoreAdapter | undefined =
    opts.todoStore === null
      ? undefined
      : opts.todoStore !== undefined
        ? opts.todoStore
        : (() => {
            // Lazy IDB wrapper: defers openDb() until first list/replace call,
            // keeping bootKernelOffscreen synchronous so chrome.runtime.onConnect
            // is registered before any async work begins.
            let storePromise: Promise<TodoStoreAdapter> | null = null
            const getStore = (): Promise<TodoStoreAdapter> => {
              if (!storePromise) storePromise = openDb().then((db) => createIdbTodoStore(db))
              return storePromise
            }
            return {
              async list(conversationId) {
                return (await getStore()).list(conversationId)
              },
              async replace(conversationId, items) {
                return (await getStore()).replace(conversationId, items)
              },
            }
          })()

  const todoEnabled = opts.todoStore !== null
  const tools = todoEnabled
    ? [...(opts.tools ?? []), todoWriteTool]
    : [...(opts.tools ?? [])]

  const agentService = createAgentService({
    settings: opts.settings,
    emit,
    messageStore: opts.messageStore,
    toolContext: opts.toolContext,
    tools,
    createAgent: opts.createAgent,
    approvalAdapter: opts.approvalAdapter,
    buildApprovalContext: opts.buildApprovalContext,
    todoStore: resolvedTodoStore,
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
        await handleNewConversation(cmd.sessionId, cmd.title)
        return
      case 'chat/loadConversation':
        await handleLoadConversation(cmd.sessionId, cmd.conversationId)
        // Forward to agentService so it can emit todo/updated (T4)
        await agentService.handleCommand?.(cmd as any)
        return
      case 'chat/listConversations':
        await pushConversationsList(cmd.sessionId)
        return
      case 'chat/deleteConversation':
        await handleDeleteConversation(cmd.sessionId, cmd.conversationId)
        return
      case 'chat/resubscribe':
        await pushSnapshot(cmd.sessionId, cmd.conversationId)
        return
      case 'approval/reply':
        agentService.handleCommand?.(cmd)
        return
      case 'ping':
        // Hub ack handles it; offscreen is a no-op so the SW just stays alive.
        return
      default:
        return
    }
  }

  async function handleNewConversation(
    sessionId: string,
    title?: string,
  ): Promise<void> {
    if (typeof opts.messageStore.createConversation !== 'function') {
      // Adapter doesn't support explicit creation — push current snapshot so
      // the UI at least clears coherently when "New chat" is clicked.
      await pushSnapshot(sessionId)
      return
    }
    await opts.messageStore.createConversation({ title })
    await pushSnapshot(sessionId)
    await pushConversationsList(sessionId)
  }

  async function handleLoadConversation(
    sessionId: string,
    conversationId: string,
  ): Promise<void> {
    if (typeof opts.messageStore.setActiveConversationId === 'function') {
      await opts.messageStore.setActiveConversationId(conversationId)
    }
    await pushSnapshot(sessionId, conversationId)
    await pushConversationsList(sessionId)
  }

  async function handleDeleteConversation(
    sessionId: string,
    conversationId: string,
  ): Promise<void> {
    if (typeof opts.messageStore.deleteConversation !== 'function') return
    await opts.messageStore.deleteConversation(conversationId)
    // Whichever conversation is now active (per the adapter's policy — usually
    // the next-most-recent) becomes the snapshot we push back.
    await pushSnapshot(sessionId)
    await pushConversationsList(sessionId)
  }

  async function pushConversationsList(sessionId: string): Promise<void> {
    if (typeof opts.messageStore.listConversations !== 'function') return
    const list = await opts.messageStore.listConversations()
    const activeId = await opts.messageStore.activeConversationId()
    emit({
      id: crypto.randomUUID(),
      sessionId,
      ts: Date.now(),
      kind: 'conversations/list',
      activeId,
      conversations: list,
    })
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
