import { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import { ToolCallCard } from './ToolCallCard'
import { SubagentCard, type SubagentCardState } from './SubagentCard'

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
  subagents?: Map<string, SubagentCardState>
  callIdToSubagentId?: Map<string, string>
}

function renderToolCall(
  t: DisplayToolCall,
  subagents: Map<string, SubagentCardState> | undefined,
  callIdToSubagentId: Map<string, string> | undefined,
) {
  if (t.tool === 'Task') {
    const subagentId = callIdToSubagentId?.get(t.id)
    const subState = subagentId ? subagents?.get(subagentId) : undefined
    if (subState) {
      return <SubagentCard key={t.id} state={subState} />
    }
  }
  return (
    <ToolCallCard
      key={t.id}
      tool={t.tool}
      args={t.args}
      status={t.status}
      result={t.result}
    />
  )
}

export function MessageList({ messages, toolCalls, subagents, callIdToSubagentId }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, toolCalls.length])

  if (messages.length === 0 && toolCalls.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-sm text-slate-400">
        <div className="mb-2 text-3xl">💬</div>
        <p className="font-medium text-slate-500">Start a conversation</p>
        <p className="mt-1 text-xs">
          Ask about this page, fetch a URL, or query the DOM. The agent has tools for
          reading, screenshotting, and tab listing.
        </p>
      </div>
    )
  }

  // Tool calls whose anchor message isn't in the list (e.g., no assistant
  // placeholder yet, or anchor was lost across a snapshot reset). Render them
  // at the end so they don't disappear silently.
  const messageIds = new Set(messages.map((m) => m.id))
  const orphanToolCalls = toolCalls.filter((t) => !messageIds.has(t.afterMessageId))

  return (
    <div ref={ref} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((m) => (
        <div key={m.id} className="space-y-2">
          {m.role !== 'tool' && (
            <MessageBubble role={m.role} content={m.content} pending={m.pending} />
          )}
          {toolCalls
            .filter((t) => t.afterMessageId === m.id)
            .map((t) => renderToolCall(t, subagents, callIdToSubagentId))}
        </div>
      ))}
      {orphanToolCalls.length > 0 && (
        <div className="space-y-2">
          {orphanToolCalls.map((t) => renderToolCall(t, subagents, callIdToSubagentId))}
        </div>
      )}
    </div>
  )
}
