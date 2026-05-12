import { useEffect, useRef, useState } from 'react'
import { Fab } from './fab'
import { ChatWindow } from '../ui/ChatWindow'
import { ApprovalModal, type PendingApproval } from '../ui/ApprovalModal'
import type { DisplayMessage, DisplayToolCall } from '../ui/MessageList'
import type { ConversationItem } from '../ui/ConversationList'
import { RpcClient } from 'agent-kernel'
import { getTransientUi, setTransientUi } from '../storage/transient'
import { loadSettings } from '../storage/settings'

export function ChatApp() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [toolCalls, setToolCalls] = useState<DisplayToolCall[]>([])
  const [busy, setBusy] = useState(false)
  const [errorBanner, setErrorBanner] = useState<
    { text: string; action?: { label: string; kind: 'open-options' } } | undefined
  >(undefined)
  const [position, setPosition] = useState<'bottom-right' | 'bottom-left'>('bottom-right')
  // Latest observed prompt_tokens for the active assistant message. Each
  // iteration overwrites — represents "what's currently in the model's context".
  const [contextTokens, setContextTokens] = useState<number | null>(null)
  const [contextLimit, setContextLimit] = useState<number>(128_000)
  const [contextThresholdPercent, setContextThresholdPercent] = useState<number>(75)
  const [compactStatus, setCompactStatus] = useState<
    | { phase: 'running'; messages: number }
    | { phase: 'done'; messages: number; saved: number }
    | { phase: 'failed'; reason: string }
    | null
  >(null)
  const compactHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const clientRef = useRef<RpcClient | null>(null)
  const lastAssistantIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cleanup: (() => void) | undefined
    void (async () => {
      // Connect the RPC client FIRST. Anything else can fail without nuking
      // the agent connection.
      console.log('[mycli-web] ChatApp creating RpcClient')
      const client = new RpcClient({ portName: 'session' })
      clientRef.current = client
      try {
        await client.connect()
        console.log('[mycli-web] ChatApp client connected, sessionId:', client.sessionId)
      } catch (e) {
        console.error('[mycli-web] RpcClient connect failed:', e)
        return
      }

      try {
        const settings = await loadSettings()
        setPosition(settings.fab.position)
        setContextLimit(settings.autoCompact.modelContextWindow)
        setContextThresholdPercent(settings.autoCompact.thresholdPercent)
      } catch (e) {
        console.warn('[mycli-web] loadSettings failed (non-fatal):', e)
      }
      // Refresh context bar settings if user changes them in Options while
      // the chat is open.
      const onStorageChanged = (
        changes: { [key: string]: chrome.storage.StorageChange },
        area: chrome.storage.AreaName,
      ) => {
        if (area !== 'local' || !changes.mycliWebSettings) return
        const next = changes.mycliWebSettings.newValue?.autoCompact
        if (next) {
          if (typeof next.modelContextWindow === 'number') setContextLimit(next.modelContextWindow)
          if (typeof next.thresholdPercent === 'number') setContextThresholdPercent(next.thresholdPercent)
        }
      }
      chrome.storage.onChanged.addListener(onStorageChanged)
      try {
        const ui = await getTransientUi()
        setOpen(ui.panelOpen)
      } catch (e) {
        console.warn('[mycli-web] getTransientUi failed (non-fatal):', e)
      }

      client.on('state/snapshot', (ev: any) => {
        // Replace local message/toolCall state with server snapshot. Triggered
        // either by our explicit chat/resubscribe below or by offscreen on its
        // own (conversation switch / new / delete).
        const snap = ev.conversation
        setActiveConversationId(snap.id ?? null)
        const newMessages: DisplayMessage[] = (snap.messages ?? [])
          // Tool rows live in IndexedDB so future turns can replay them, but
          // the chat list already shows tool activity via ToolCallCard cards
          // anchored to the assistant message — rendering them as messages
          // would duplicate.
          .filter((m: any) => m.role !== 'tool')
          .map((m: any) => ({
            id: m.id,
            role: m.role === 'system-synth' ? 'assistant' : m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            pending: !!m.pending,
          }))
        setMessages(newMessages)
        // Snapshots don't carry tool calls (Plan B doesn't persist them yet);
        // clear local cache to avoid stale cards from a previous turn.
        setToolCalls([])
        // Anchor for any incoming tool/start: the last assistant message in the snapshot.
        const lastAssistant = [...newMessages].reverse().find((m) => m.role === 'assistant')
        lastAssistantIdRef.current = lastAssistant?.id ?? null
        // If snapshot ends with a still-pending assistant, an agent loop is
        // probably mid-flight; preserve busy. Otherwise clear it.
        const tail = newMessages[newMessages.length - 1]
        setBusy(!!(tail && tail.role === 'assistant' && tail.pending))
      })

      client.on('message/appended', (ev: any) => {
        const msg = ev.message
        // Tool rows are persisted but not rendered in the message list — the
        // ToolCallCard handles their display.
        if (msg.role === 'tool') return
        const isPending = !!msg.pending
        setMessages((prev) => {
          if (prev.find((p) => p.id === msg.id)) {
            return prev.map((p) =>
              p.id === msg.id
                ? { ...p, content: msg.content, pending: isPending }
                : p,
            )
          }
          // Reconcile with an optimistic placeholder added by send() — if a
          // user message with matching content is sitting in the list with a
          // synthetic id, swap its id rather than appending a duplicate.
          if (msg.role === 'user') {
            const optimisticIdx = prev.findIndex(
              (p) =>
                p.id.startsWith('optimistic:') &&
                p.role === 'user' &&
                p.content === msg.content,
            )
            if (optimisticIdx >= 0) {
              const copy = [...prev]
              copy[optimisticIdx] = {
                ...copy[optimisticIdx],
                id: msg.id,
                pending: isPending,
              }
              return copy
            }
          }
          return [
            ...prev,
            {
              id: msg.id,
              role: msg.role === 'system-synth' ? 'assistant' : msg.role,
              content: msg.content,
              pending: isPending,
            },
          ]
        })
        if (msg.role === 'assistant') {
          lastAssistantIdRef.current = msg.id
          // Only clear busy state on terminal assistant message (the placeholder
          // emitted at runChat start carries pending: true and must NOT clear it).
          if (!isPending) setBusy(false)
        }
      })

      client.on('conversations/list', (ev: any) => {
        setConversations(
          (ev.conversations ?? []).map((c: any) => ({
            id: c.id,
            title: c.title,
            updatedAt: c.updatedAt,
          })),
        )
        setActiveConversationId(ev.activeId ?? null)
      })

      client.on('compact/started', (ev: any) => {
        if (compactHideTimerRef.current) {
          clearTimeout(compactHideTimerRef.current)
          compactHideTimerRef.current = null
        }
        setCompactStatus({ phase: 'running', messages: ev.messagesToCompact })
      })

      client.on('compact/completed', (ev: any) => {
        const saved = Math.max(0, ev.beforeTokens - ev.afterTokens)
        setCompactStatus({ phase: 'done', messages: ev.messagesCompacted, saved })
        compactHideTimerRef.current = setTimeout(() => setCompactStatus(null), 4000)
      })

      client.on('compact/failed', (ev: any) => {
        setCompactStatus({ phase: 'failed', reason: ev.reason })
        compactHideTimerRef.current = setTimeout(() => setCompactStatus(null), 6000)
      })

      client.on('message/usage', (ev: any) => {
        // input = prompt_tokens of the latest LLM call = "what's currently in
        // the model's context window". Each iteration overwrites because this
        // value already counts everything before it (history + system + user).
        setContextTokens(ev.input)
      })

      client.on('message/streamChunk', (ev: any) => {
        lastAssistantIdRef.current = ev.messageId
        setMessages((prev) => {
          const idx = prev.findIndex((p) => p.id === ev.messageId)
          if (idx === -1) {
            return [
              ...prev,
              { id: ev.messageId, role: 'assistant', content: ev.delta, pending: true },
            ]
          }
          const copy = [...prev]
          copy[idx] = { ...copy[idx], content: copy[idx].content + ev.delta, pending: true }
          return copy
        })
      })

      client.on('tool/start', (ev: any) => {
        const anchor = lastAssistantIdRef.current ?? ''
        setToolCalls((prev) => [
          ...prev,
          {
            id: ev.toolCall.id,
            tool: ev.toolCall.tool,
            args: ev.toolCall.args,
            status: 'running',
            afterMessageId: anchor,
          },
        ])
      })

      client.on('tool/end', (ev: any) => {
        setToolCalls((prev) =>
          prev.map((t) =>
            t.id === ev.toolCallId
              ? { ...t, status: ev.result.ok ? 'ok' : 'error', result: ev.result.content }
              : t,
          ),
        )
      })

      client.on('fatalError', (ev: any) => {
        setBusy(false)
        if (ev.code === 'no_api_key') {
          setErrorBanner({
            text: 'API key not configured. Open Options to set it.',
            action: { label: 'Open Options', kind: 'open-options' },
          })
        } else {
          setErrorBanner({ text: `${ev.code}: ${ev.message}` })
        }
      })

      // Cross-context runtime errors (uncaught exceptions / unhandled
      // rejections from SW or offscreen). Surfaces them in this tab's F12
      // so devs don't have to chase three separate DevTools windows.
      client.on('runtime/error' as any, (ev: any) => {
        console.error(
          `[mycli-web/${ev.source}] runtime error:`,
          ev.message,
          ev.stack ?? '',
        )
        setErrorBanner({ text: `${ev.source} error: ${ev.message}` })
      })

      client.on('approval/requested' as any, (ev: any) => {
        const a = ev.approval
        if (!a) return
        setPendingApproval({
          approvalId: a.id,
          tool: a.tool,
          argsSummary: a.argsSummary,
          origin: a.origin,
        })
      })

      // Resubscribe to the active conversation so reopening the chat or
      // navigating between pages restores prior messages from IDB.
      try {
        await client.send({ kind: 'chat/resubscribe' })
      } catch (e) {
        console.warn('[mycli-web] chat/resubscribe failed:', e)
      }
      // Pull the conversation list so the switcher menu has data.
      try {
        await client.send({ kind: 'chat/listConversations' })
      } catch (e) {
        console.warn('[mycli-web] chat/listConversations failed:', e)
      }

      const tabListener = (msg: any) => {
        if (msg?.kind === 'content/activate') setOpen(true)
      }
      chrome.runtime.onMessage.addListener(tabListener)

      // MV3 service workers die after ~30s idle. After a long agent turn the
      // session port goes quiet, the SW gets killed, and the next chat/send
      // hits a "zombie port" (not disconnected on this side, but the message
      // never arrives at the new SW). Send a ping every 25s to keep the SW
      // warm. The hub acks pings unconditionally, so this is a no-op turn.
      const heartbeat = setInterval(() => {
        clientRef.current?.send({ kind: 'ping' }).catch(() => {})
      }, 25_000)

      cleanup = () => {
        chrome.runtime.onMessage.removeListener(tabListener)
        chrome.storage.onChanged.removeListener(onStorageChanged)
        clearInterval(heartbeat)
        if (compactHideTimerRef.current) clearTimeout(compactHideTimerRef.current)
      }
    })()
    return () => {
      cleanup?.()
    }
  }, [])

  async function toggle() {
    const next = !open
    setOpen(next)
    await setTransientUi({ panelOpen: next })
  }

  function send(text: string) {
    console.log('[mycli-web] ChatApp.send called; client connected:', !!clientRef.current, 'text:', text)
    if (!clientRef.current) {
      setErrorBanner({ text: 'RpcClient not connected — check SW/offscreen.' })
      return
    }
    // Optimistic UI: show the user's message immediately so they see it land
    // even if the SW is slow to wake up or the round-trip lags. The real
    // message/appended echo from offscreen will reconcile this entry by id.
    const optimisticId = `optimistic:${crypto.randomUUID()}`
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content: text },
    ])
    setBusy(true)
    setErrorBanner(undefined)
    clientRef.current.send({ kind: 'chat/send', text }).then((ack) => {
      console.log('[mycli-web] chat/send ack:', ack)
      if (!ack.ok) {
        setBusy(false)
        setErrorBanner({ text: `ack failed: ${ack.error.code}: ${ack.error.message}` })
      }
    })
  }

  function stop() {
    if (!clientRef.current) return
    clientRef.current.send({ kind: 'chat/cancel' })
    // Optimistic — busy will officially clear when the engine surfaces a
    // 'done' (with stopReason 'cancel' or 'error') and offscreen emits the
    // terminal message/appended. Snapshot sync would also reset it.
    setBusy(false)
  }

  function resetTurnState() {
    setMessages([])
    setToolCalls([])
    lastAssistantIdRef.current = null
    setContextTokens(null)
    setCompactStatus(null)
    if (compactHideTimerRef.current) {
      clearTimeout(compactHideTimerRef.current)
      compactHideTimerRef.current = null
    }
    setBusy(false)
    setErrorBanner(undefined)
  }

  function newConversation() {
    if (!clientRef.current) return
    resetTurnState()
    clientRef.current.send({ kind: 'chat/newConversation' })
  }

  function selectConversation(id: string) {
    if (!clientRef.current) return
    if (id === activeConversationId) return
    resetTurnState()
    clientRef.current.send({ kind: 'chat/loadConversation', conversationId: id })
  }

  function deleteConversation(id: string) {
    if (!clientRef.current) return
    // If we're deleting the currently shown one, clear local state so the
    // post-delete snapshot (whichever conversation becomes active) renders
    // cleanly without flashing the deleted one's leftover messages.
    if (id === activeConversationId) resetTurnState()
    clientRef.current.send({ kind: 'chat/deleteConversation', conversationId: id })
  }

  function dismissError(action?: { kind: 'open-options' }) {
    if (action?.kind === 'open-options') {
      try {
        chrome.runtime.openOptionsPage()
      } catch (e) {
        console.warn('[mycli-web] openOptionsPage failed:', e)
      }
    }
    setErrorBanner(undefined)
  }

  function replyApproval(approvalId: string, decision: 'once' | 'session' | 'always' | 'deny') {
    clientRef.current?.send({ kind: 'approval/reply', approvalId, decision } as any).catch(() => {})
    setPendingApproval(null)
  }

  return (
    <>
      <Fab onClick={toggle} position={position} />
      {open && (
        <ChatWindow
          messages={messages}
          toolCalls={toolCalls}
          onSend={send}
          onStop={stop}
          onNewConversation={newConversation}
          busy={busy}
          errorBanner={errorBanner}
          onDismissError={dismissError}
          contextTokens={contextTokens}
          contextLimit={contextLimit}
          contextThresholdPercent={contextThresholdPercent}
          compactStatus={compactStatus}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={selectConversation}
          onDeleteConversation={deleteConversation}
        />
      )}
      <ApprovalModal pending={pendingApproval} onReply={replyApproval} />
    </>
  )
}
