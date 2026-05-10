import { MessageList, type DisplayMessage, type DisplayToolCall } from './MessageList'
import { Composer } from './Composer'

interface ErrorBanner {
  text: string
  action?: { label: string; kind: 'open-options' }
}

interface Props {
  messages: DisplayMessage[]
  toolCalls: DisplayToolCall[]
  onSend: (text: string) => void
  onStop: () => void
  onNewConversation: () => void
  busy: boolean
  errorBanner?: ErrorBanner
  onDismissError: (action?: { kind: 'open-options' }) => void
  contextTokens: number | null
  contextLimit: number
  contextThresholdPercent: number
  compactStatus?:
    | { phase: 'running'; messages: number }
    | { phase: 'done'; messages: number; saved: number }
    | { phase: 'failed'; reason: string }
    | null
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

interface ContextBarProps {
  used: number | null
  limit: number
  thresholdPercent: number
}

function ContextBar({ used, limit, thresholdPercent }: ContextBarProps) {
  const usedPct = used == null ? 0 : Math.min(100, (used / limit) * 100)
  const thr = Math.min(99, Math.max(1, thresholdPercent))

  // Color the fill by proximity to the compaction threshold:
  //   < threshold       → slate (idle)
  //   threshold..90%    → amber (compaction will trigger soon)
  //   ≥ 90%             → red   (close to overflow)
  const fillColor =
    usedPct >= 90
      ? 'bg-red-500'
      : usedPct >= thr
        ? 'bg-amber-500'
        : 'bg-emerald-500'

  const label =
    used == null
      ? `— / ${formatTokens(limit)}`
      : `${formatTokens(used)} / ${formatTokens(limit)} · ${usedPct.toFixed(0)}%`

  return (
    <div
      className="flex flex-col items-end gap-0.5"
      title={
        used == null
          ? `Context window: ${limit} tokens. Compaction triggers at ${thr}%.`
          : `Context: ${used} / ${limit} tokens used (${usedPct.toFixed(1)}%). Compaction triggers at ${thr}% (${Math.floor((limit * thr) / 100)} tokens).`
      }
    >
      <span className="font-mono text-[10px] font-normal text-slate-500">
        {label}
      </span>
      <div className="relative h-1 w-24 overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full transition-all ${fillColor}`}
          style={{ width: `${usedPct}%` }}
        />
        {/* Threshold marker: a thin vertical line where auto-compaction triggers */}
        <div
          className="absolute top-0 h-full w-px bg-slate-400/70"
          style={{ left: `${thr}%` }}
        />
      </div>
    </div>
  )
}

export function ChatWindow({
  messages,
  toolCalls,
  onSend,
  onStop,
  onNewConversation,
  busy,
  errorBanner,
  onDismissError,
  contextTokens,
  contextLimit,
  contextThresholdPercent,
  compactStatus,
}: Props) {
  return (
    <div
      className="fixed right-4 bottom-20 flex h-[32rem] w-96 flex-col rounded-lg border border-slate-200 bg-white shadow-xl"
      style={{ zIndex: 2147483647 }}
    >
      <div className="flex h-10 items-center justify-between border-b border-slate-200 px-3 text-sm font-semibold text-slate-700">
        <span>mycli-web</span>
        <div className="flex items-center gap-3">
          <ContextBar
            used={contextTokens}
            limit={contextLimit}
            thresholdPercent={contextThresholdPercent}
          />
          <button
            onClick={onNewConversation}
            className="rounded px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            type="button"
          >
            New chat
          </button>
        </div>
      </div>
      {compactStatus && (
        <div
          className={
            'flex items-center gap-2 border-b px-3 py-1 text-[11px] ' +
            (compactStatus.phase === 'failed'
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-slate-200 bg-slate-50 text-slate-600')
          }
        >
          {compactStatus.phase === 'running' && (
            <>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
              <span>Compacting {compactStatus.messages} earlier messages…</span>
            </>
          )}
          {compactStatus.phase === 'done' && (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
              <span>
                Compacted {compactStatus.messages} messages
                {compactStatus.saved > 0 && ` · saved ~${formatTokens(compactStatus.saved)} tokens`}
              </span>
            </>
          )}
          {compactStatus.phase === 'failed' && (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
              <span>Compact skipped: {compactStatus.reason}</span>
            </>
          )}
        </div>
      )}
      {errorBanner && (
        <div className="flex items-start justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
          <span className="flex-1">{errorBanner.text}</span>
          <div className="flex shrink-0 items-center gap-1">
            {errorBanner.action && (
              <button
                type="button"
                onClick={() => onDismissError(errorBanner.action)}
                className="rounded bg-red-100 px-2 py-0.5 font-medium text-red-800 hover:bg-red-200"
              >
                {errorBanner.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => onDismissError()}
              className="rounded px-1 text-red-500 hover:bg-red-100"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      <MessageList messages={messages} toolCalls={toolCalls} />
      <Composer onSend={onSend} onStop={onStop} busy={busy} />
    </div>
  )
}
