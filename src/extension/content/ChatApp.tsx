import { useEffect, useRef, useState } from 'react'
import { Fab } from './fab'
import { ChatWindow } from '../ui/ChatWindow'
import type { DisplayMessage, DisplayToolCall } from '../ui/MessageList'
import { RpcClient } from '../rpc/client'
import { getTransientUi, setTransientUi } from '../storage/transient'
import { loadSettings } from '../storage/settings'

export function ChatApp() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [toolCalls, setToolCalls] = useState<DisplayToolCall[]>([])
  const [busy, setBusy] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | undefined>(undefined)
  const [position, setPosition] = useState<'bottom-right' | 'bottom-left'>('bottom-right')
  const clientRef = useRef<RpcClient | null>(null)
  const lastAssistantIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cleanup: (() => void) | undefined
    void (async () => {
      const settings = await loadSettings()
      setPosition(settings.fab.position)
      const ui = await getTransientUi()
      setOpen(ui.panelOpen)

      const client = new RpcClient({ portName: 'session' })
      clientRef.current = client
      await client.connect()

      client.on('message/appended', (ev: any) => {
        setMessages((prev) => {
          if (prev.find((p) => p.id === ev.message.id)) {
            return prev.map((p) =>
              p.id === ev.message.id
                ? { ...p, content: ev.message.content, pending: false }
                : p,
            )
          }
          return [
            ...prev,
            {
              id: ev.message.id,
              role: ev.message.role,
              content: ev.message.content,
              pending: false,
            },
          ]
        })
        if (ev.message.role === 'assistant') {
          lastAssistantIdRef.current = ev.message.id
          setBusy(false)
        }
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
        setErrorBanner(`${ev.code}: ${ev.message}`)
      })

      const tabListener = (msg: any) => {
        if (msg?.kind === 'content/activate') setOpen(true)
      }
      chrome.runtime.onMessage.addListener(tabListener)
      cleanup = () => chrome.runtime.onMessage.removeListener(tabListener)
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
    if (!clientRef.current) return
    setBusy(true)
    setErrorBanner(undefined)
    clientRef.current.send({ kind: 'chat/send', text })
  }

  function newConversation() {
    if (!clientRef.current) return
    setMessages([])
    setToolCalls([])
    clientRef.current.send({ kind: 'chat/newConversation' })
  }

  return (
    <>
      <Fab onClick={toggle} position={position} />
      {open && (
        <ChatWindow
          messages={messages}
          toolCalls={toolCalls}
          onSend={send}
          onNewConversation={newConversation}
          busy={busy}
          errorBanner={errorBanner}
        />
      )}
    </>
  )
}
