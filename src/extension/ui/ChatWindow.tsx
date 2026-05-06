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
}: Props) {
  return (
    <div
      className="fixed right-4 bottom-20 flex h-[32rem] w-96 flex-col rounded-lg border border-slate-200 bg-white shadow-xl"
      style={{ zIndex: 2147483647 }}
    >
      <div className="flex h-10 items-center justify-between border-b border-slate-200 px-3 text-sm font-semibold text-slate-700">
        <span>mycli-web</span>
        <button
          onClick={onNewConversation}
          className="rounded px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          type="button"
        >
          New chat
        </button>
      </div>
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
