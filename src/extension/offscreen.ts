import { ClientCmd } from './rpc/protocol'
import { createAgent, type AgentEvent } from '@core'
import type { ChatMessage } from '@core'
import { fetchGetTool } from '@core/tools/fetchGet'
import { extensionTools, type ExtensionToolCtx, type ExtensionToolRpc } from '@ext-tools'
import { loadSettings } from './storage/settings'
import {
  createConversation,
  getConversation,
  listConversations,
} from './storage/conversations'
import {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
} from './storage/messages'

console.log('[mycli-web] offscreen agent runtime booted at', new Date().toISOString())

let swPort: chrome.runtime.Port | null = null
const activeAborts = new Map<string, { abort: () => void }>()

// SW will connect to us via chrome.runtime.connect({ name: 'sw-to-offscreen' }).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sw-to-offscreen') return
  swPort = port
  port.onMessage.addListener((raw) => handleClientCmd(raw))
  port.onDisconnect.addListener(() => {
    swPort = null
    for (const [, ac] of activeAborts) ac.abort()
    activeAborts.clear()
  })
})

function emit(ev: any) {
  swPort?.postMessage(ev)
}

async function handleClientCmd(raw: unknown) {
  const parsed = ClientCmd.safeParse(raw)
  if (!parsed.success) return
  const cmd = parsed.data
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
      })),
    },
  })
}

async function runChat(cmd: { sessionId: string; text: string }) {
  console.log('[mycli-web/offscreen] runChat start, text:', cmd.text)
  const settings = await loadSettings()
  console.log(
    '[mycli-web/offscreen] settings loaded; apiKey set:',
    !!settings.apiKey,
    'baseUrl:',
    settings.baseUrl,
    'model:',
    settings.model,
  )
  if (!settings.apiKey) {
    console.warn('[mycli-web/offscreen] no apiKey — emitting fatalError')
    emit({
      id: crypto.randomUUID(),
      sessionId: cmd.sessionId,
      ts: Date.now(),
      kind: 'fatalError',
      code: 'no_api_key',
      message: 'Configure API key in extension options first.',
    })
    return
  }

  const cid = await activeConversationId()
  const userMsg = await appendMessage({
    conversationId: cid,
    role: 'user',
    content: cmd.text,
  })
  emit({
    id: crypto.randomUUID(),
    sessionId: cmd.sessionId,
    ts: Date.now(),
    kind: 'message/appended',
    message: {
      id: userMsg.id,
      role: 'user',
      content: cmd.text,
      createdAt: userMsg.createdAt,
    },
  })

  // Load prior conversation history (everything except the just-appended user
  // message) so the LLM retains context from previous turns.
  const allHistory = await listMessagesByConversation(cid)
  const priorHistory: ChatMessage[] = allHistory
    .filter((m) => !m.compacted)
    .filter((m) => m.id !== userMsg.id)
    .map((m) => ({
      role:
        m.role === 'system-synth' ? 'system' : (m.role as ChatMessage['role']),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))

  // ToolExecContext fields shared by all tools (chrome backend).
  const tabId = (await guessActiveTab())?.id
  const rpc: ExtensionToolRpc = {
    domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
    chromeApi: (method, args) => callChromeApi(method, args),
  }
  const toolContext: ExtensionToolCtx = {
    rpc,
    tabId,
    conversationId: cid,
  }

  const agent = createAgent({
    llm: { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model },
    tools: [fetchGetTool, ...extensionTools],
    toolContext,
    toolMaxIterations: settings.toolMaxIterations,
    systemPrompt: settings.systemPromptAddendum || undefined,
  })

  // Track this session's agent so chat/cancel can abort it.
  activeAborts.set(cmd.sessionId, { abort: () => agent.cancel() })

  const assistantMsg = await appendMessage({
    conversationId: cid,
    role: 'assistant',
    content: '',
    pending: true,
  })

  try {
    for await (const ev of agent.send(cmd.text, { history: priorHistory }) as AsyncIterable<AgentEvent>) {
      if (ev.kind === 'message/streamChunk') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/streamChunk',
          messageId: assistantMsg.id,
          delta: ev.delta,
        })
      } else if (ev.kind === 'tool/start') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/start',
          toolCall: ev.toolCall,
        })
      } else if (ev.kind === 'tool/end') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/end',
          toolCallId: ev.toolCallId,
          result: ev.result,
        })
      } else if (ev.kind === 'done') {
        await updateMessage(assistantMsg.id, {
          content: ev.assistantText,
          pending: false,
        })
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/appended',
          message: {
            id: assistantMsg.id,
            role: 'assistant',
            content: ev.assistantText,
            createdAt: assistantMsg.createdAt,
          },
        })
      }
    }
  } catch (e: any) {
    emit({
      id: crypto.randomUUID(),
      sessionId: cmd.sessionId,
      ts: Date.now(),
      kind: 'fatalError',
      code: 'engine_error',
      message: e?.message ?? String(e),
    })
  } finally {
    activeAborts.delete(cmd.sessionId)
  }
}

async function guessActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return tabs[0]
  } catch {
    return undefined
  }
}

async function sendDomOp(op: any, timeoutMs: number) {
  return new Promise<any>((resolve) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(
      () =>
        resolve({
          ok: false,
          error: { code: 'dom_op_timeout', message: 'no response', retryable: false },
        }),
      timeoutMs,
    )
    const listener = (msg: any) => {
      if (msg?.kind === 'dom_op_result' && msg.id === id) {
        chrome.runtime.onMessage.removeListener(listener)
        clearTimeout(timer)
        resolve(msg.result)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    chrome.runtime.sendMessage({ kind: 'dom_op_request', id, op })
  })
}

async function callChromeApi(method: string, args: unknown[]): Promise<any> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const listener = (msg: any) => {
      if (msg?.kind === 'chrome_api_result' && msg.id === id) {
        chrome.runtime.onMessage.removeListener(listener)
        resolve(msg.result)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    chrome.runtime.sendMessage({ kind: 'chrome_api_request', id, method, args })
  })
}
