import { ClientCmd } from './rpc/protocol'
import { OpenAICompatibleClient, type ChatMessage } from '@/agent/api/openaiCompatibleClient'
import { QueryEngine } from '@/agent/query/QueryEngine'
import { ToolRegistry } from '@/tools/registry'
import { readPageTool } from '@/tools/readPage'
import { readSelectionTool } from '@/tools/readSelection'
import { querySelectorTool } from '@/tools/querySelector'
import { screenshotTool } from '@/tools/screenshot'
import { listTabsTool } from '@/tools/listTabs'
import { fetchGetTool } from '@/tools/fetchGet'
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
import type { ToolCall, ToolExecContext } from '@shared/types'

console.log('[mycli-web] offscreen agent runtime booted at', new Date().toISOString())

const registry = new ToolRegistry()
registry.register(readPageTool)
registry.register(readSelectionTool)
registry.register(querySelectorTool)
registry.register(screenshotTool)
registry.register(listTabsTool)
registry.register(fetchGetTool)

let swPort: chrome.runtime.Port | null = null
const activeAborts = new Map<string, AbortController>()

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
  const settings = await loadSettings()
  if (!settings.apiKey) {
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

  const history = await listMessagesByConversation(cid)
  const llmHistory: ChatMessage[] = history
    .filter((m) => !m.compacted)
    .map((m) => ({
      role:
        m.role === 'system-synth'
          ? 'system'
          : (m.role as ChatMessage['role']),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))

  const client = new OpenAICompatibleClient({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
  })

  const abort = new AbortController()
  activeAborts.set(cmd.sessionId, abort)

  const tabId = (await guessActiveTab())?.id
  const ctx: ToolExecContext = {
    conversationId: cid,
    tabId,
    rpc: {
      domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
      chromeApi: (method, args) => callChromeApi(method, args),
    },
  }

  const engine = new QueryEngine({
    client,
    tools: registry.toOpenAi(),
    executeTool: async (call: ToolCall) => {
      const def = registry.get(call.name)
      if (!def) {
        return {
          ok: false,
          error: { code: 'unknown_tool', message: call.name, retryable: false },
        }
      }
      return def.execute(call.input as any, ctx)
    },
    toolMaxIterations: settings.toolMaxIterations,
    systemPrompt: settings.systemPromptAddendum || undefined,
    signal: abort.signal,
  })

  const assistantMsg = await appendMessage({
    conversationId: cid,
    role: 'assistant',
    content: '',
    pending: true,
  })

  let assistantBuf = ''
  try {
    for await (const ev of engine.run(llmHistory)) {
      if (ev.kind === 'assistant_delta') {
        assistantBuf += ev.text
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/streamChunk',
          messageId: assistantMsg.id,
          delta: ev.text,
        })
      } else if (ev.kind === 'tool_executing') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/start',
          toolCall: { id: ev.call.id, tool: ev.call.name, args: ev.call.input },
        })
      } else if (ev.kind === 'tool_result') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/end',
          toolCallId: ev.callId,
          result: { ok: !ev.isError, content: ev.content },
        })
      } else if (ev.kind === 'done') {
        await updateMessage(assistantMsg.id, { content: assistantBuf, pending: false })
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/appended',
          message: {
            id: assistantMsg.id,
            role: 'assistant',
            content: assistantBuf,
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
