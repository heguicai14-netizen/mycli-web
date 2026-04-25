import { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import { ToolCallCard } from './ToolCallCard'

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  pending?: boolean
}

export interface DisplayToolCall {
  id: string
  tool: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  result?: string
  /** Anchor: insert after this assistant message id */
  afterMessageId: string
}

interface Props {
  messages: DisplayMessage[]
  toolCalls: DisplayToolCall[]
}

export function MessageList({ messages, toolCalls }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, toolCalls.length])

  return (
    <div ref={ref} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((m) => (
        <div key={m.id} className="space-y-2">
          {m.role !== 'tool' && (
            <MessageBubble role={m.role} content={m.content} pending={m.pending} />
          )}
          {toolCalls
            .filter((t) => t.afterMessageId === m.id)
            .map((t) => (
              <ToolCallCard
                key={t.id}
                tool={t.tool}
                args={t.args}
                status={t.status}
                result={t.result}
              />
            ))}
        </div>
      ))}
    </div>
  )
}
