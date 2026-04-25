import { MessageList, type DisplayMessage, type DisplayToolCall } from './MessageList'
import { Composer } from './Composer'

interface Props {
  messages: DisplayMessage[]
  toolCalls: DisplayToolCall[]
  onSend: (text: string) => void
  onNewConversation: () => void
  busy: boolean
  errorBanner?: string
}

export function ChatWindow({
  messages,
  toolCalls,
  onSend,
  onNewConversation,
  busy,
  errorBanner,
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
        <div className="border-b border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
          {errorBanner}
        </div>
      )}
      <MessageList messages={messages} toolCalls={toolCalls} />
      <Composer onSend={onSend} disabled={busy} />
    </div>
  )
}
