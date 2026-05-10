// IMPORTANT: polyfill must run before any module touches chrome.storage /
// chrome.tabs. Other imports below are side-effect-free at module level.
import { polyfillChromeApiInOffscreen } from 'agent-kernel'
polyfillChromeApiInOffscreen()

import {
  ClientCmd,
  createAgentService,
  createIdbMessageStore,
  sendDomOp,
  callChromeApi,
  fetchGetTool,
  createConversation,
  getConversation,
  listConversations,
  listMessagesByConversation,
  type ToolContextBuilder,
} from 'agent-kernel'
import { extensionTools, type ExtensionToolCtx, type ExtensionToolRpc } from '@ext-tools'
import { useSkillTool, readSkillFileTool } from '@ext-skills'
import { mycliSettingsAdapter } from './settingsAdapter'

console.log('[mycli-web] offscreen agent runtime booted at', new Date().toISOString())

// Sentinel sessionId for runtime-wide events that don't belong to any chat session.
const SENTINEL_SESSION_ID = '00000000-0000-4000-8000-000000000000'

let swPort: chrome.runtime.Port | null = null
const activeAborts = new Map<string, { abort: () => void }>()

// Holds runtime/error events that fired before the SW port came up.
const pendingRuntimeErrors: any[] = []

// SW will connect to us via chrome.runtime.connect({ name: 'sw-to-offscreen' }).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sw-to-offscreen') return
  console.log('[mycli-web/offscreen] SW connected')
  swPort = port
  // Drain any runtime errors that occurred before the SW connected — they
  // need to reach content tabs for F12 visibility.
  while (pendingRuntimeErrors.length) port.postMessage(pendingRuntimeErrors.shift())
  port.onMessage.addListener((raw) => handleClientCmd(raw))
  port.onDisconnect.addListener(() => {
    console.warn('[mycli-web/offscreen] SW disconnected')
    swPort = null
    for (const [, ac] of activeAborts) ac.abort()
    activeAborts.clear()
  })
})

function emit(ev: any) {
  swPort?.postMessage(ev)
}

function reportOffscreenRuntimeError(message: string, stack?: string) {
  const ev = {
    id: crypto.randomUUID(),
    sessionId: SENTINEL_SESSION_ID,
    ts: Date.now(),
    kind: 'runtime/error' as const,
    source: 'offscreen' as const,
    message,
    stack,
  }
  console.error('[mycli-web/offscreen] runtime error:', message, stack ?? '')
  if (swPort) swPort.postMessage(ev)
  else pendingRuntimeErrors.push(ev)
}

self.addEventListener('error', (e: ErrorEvent) => {
  reportOffscreenRuntimeError(
    e.message || 'uncaught error',
    e.error?.stack,
  )
})
self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason = e.reason as any
  const message =
    typeof reason === 'string'
      ? reason
      : reason?.message ?? 'unhandled rejection'
  reportOffscreenRuntimeError(message, reason?.stack)
})

async function handleClientCmd(raw: unknown) {
  const parsed = ClientCmd.safeParse(raw)
  if (!parsed.success) {
    console.warn('[mycli-web/offscreen] ClientCmd schema_invalid:', parsed.error.message, 'raw kind:', (raw as any)?.kind)
    return
  }
  const cmd = parsed.data
  console.log('[mycli-web/offscreen] cmd received:', cmd.kind, 'session', cmd.sessionId)
  switch (cmd.kind) {
    case 'chat/send':
      void runChat(cmd)
      return
    case 'chat/cancel':
      for (const [, ac] of activeAborts) ac.abort()
      activeAborts.clear()
      return
    case 'chat/newConversation':
      await createConversation({ title: cmd.title ?? 'New chat' })
      return
    case 'chat/resubscribe':
      await pushSnapshot(cmd.sessionId, cmd.conversationId)
      return
    default:
      return
  }
}

async function activeConversationId(): Promise<string> {
  const all = await listConversations()
  if (all.length > 0) return all[0].id
  const conv = await createConversation({ title: 'New chat' })
  return conv.id
}

async function pushSnapshot(sessionId: string, conversationId?: string) {
  const cid = conversationId ?? (await activeConversationId())
  const conv = await getConversation(cid)
  if (!conv) return
  const messages = await listMessagesByConversation(cid)
  emit({
    id: crypto.randomUUID(),
    sessionId,
    ts: Date.now(),
    kind: 'state/snapshot',
    conversation: {
      id: conv.id,
      title: conv.title,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        pending: (m as { pending?: boolean }).pending,
      })),
    },
  })
}

// ExtensionToolCtx doesn't carry an index signature so the generic constraint
// `Record<string, unknown>` rejects it directly; cast through unknown — the
// agent loop passes the ctx verbatim to tools that already expect this shape.
const mycliToolContext = {
  async build(cid: string | undefined): Promise<ExtensionToolCtx> {
    const tabId = (await guessActiveTab())?.id
    const rpc: ExtensionToolRpc = {
      domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
      chromeApi: (method, args) => callChromeApi(method, args),
    }
    return { rpc, tabId, conversationId: cid }
  },
} as unknown as ToolContextBuilder

const agentService = createAgentService({
  settings: mycliSettingsAdapter,
  emit,
  messageStore: createIdbMessageStore({ defaultConversationTitle: 'New chat' }),
  toolContext: mycliToolContext,
  // Kernel default is just [fetchGetTool]; extend with mycli-web's
  // extension/skill tool sets explicitly.
  tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool],
})

async function runChat(cmd: {
  sessionId: string
  text: string
  system?: string
  tools?: string[]
  model?: string
  ephemeral?: boolean
}) {
  await agentService.runTurn(cmd, (cancel) => {
    activeAborts.set(cmd.sessionId, { abort: cancel })
  })
  activeAborts.delete(cmd.sessionId)
}

async function guessActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return tabs[0]
  } catch {
    return undefined
  }
}

