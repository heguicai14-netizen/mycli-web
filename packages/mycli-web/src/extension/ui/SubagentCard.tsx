import { useState } from 'react'

export interface SubagentCardState {
  id: string
  type: string
  description: string
  status: 'running' | 'finished' | 'failed' | 'aborted'
  messages: Array<{ text: string; ts: number }>
  toolCalls: Map<
    string,
    { name: string; args: unknown; result?: unknown; error?: unknown; ok?: boolean }
  >
  finalText?: string
  error?: { code: string; message: string }
}

interface Props {
  state: SubagentCardState
}

const STATUS_GLYPH = {
  running: '⟳',
  finished: '✓',
  failed: '✗',
  aborted: '⊘',
} as const

const STATUS_COLOR = {
  running: 'text-blue-600',
  finished: 'text-green-600',
  failed: 'text-red-600',
  aborted: 'text-slate-500',
} as const

export function SubagentCard({ state }: Props) {
  const [expanded, setExpanded] = useState(false)
  const glyph = STATUS_GLYPH[state.status]
  return (
    <div
      className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
      data-status={state.status}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`font-mono ${STATUS_COLOR[state.status]}`}>{glyph}</span>
        <span className="font-mono font-semibold">{state.type}</span>
        <span className="truncate text-slate-500">{state.description}</span>
      </button>
      {state.status === 'finished' && state.finalText && !expanded && (
        <div className="mt-1 truncate text-slate-600">{state.finalText.slice(0, 200)}</div>
      )}
      {state.status === 'failed' && state.error && (
        <div className="mt-1 text-red-600">
          {state.error.code}: {state.error.message}
        </div>
      )}
      {expanded && (
        <div className="mt-2 space-y-1">
          {state.messages.map((m, i) => (
            <div key={i} className="whitespace-pre-wrap text-slate-700">
              {m.text}
            </div>
          ))}
          {Array.from(state.toolCalls.entries()).map(([callId, tc]) => (
            <div key={callId} className="font-mono text-slate-500">
              <code>{tc.name}</code>
              {tc.ok === false && <span className="text-red-500"> (error)</span>}
            </div>
          ))}
          {state.status === 'finished' && state.finalText && (
            <div className="mt-1 whitespace-pre-wrap text-slate-700">{state.finalText}</div>
          )}
        </div>
      )}
    </div>
  )
}
