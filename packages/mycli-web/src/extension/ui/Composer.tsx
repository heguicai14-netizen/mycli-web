import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

interface Props {
  onSend: (text: string) => void
  onStop?: () => void
  busy?: boolean
}

const MIN_HEIGHT_PX = 64
const MAX_HEIGHT_PX = 200

export function Composer({ onSend, onStop, busy }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-focus when the chat window first renders so users can start typing
  // immediately after toggling it open.
  useEffect(() => {
    ref.current?.focus()
  }, [])

  // Auto-grow up to MAX_HEIGHT_PX, then start scrolling internally.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = `${MIN_HEIGHT_PX}px`
    const target = Math.min(Math.max(el.scrollHeight, MIN_HEIGHT_PX), MAX_HEIGHT_PX)
    el.style.height = `${target}px`
  }, [text])

  function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!text.trim() || busy) return
    onSend(text.trim())
    setText('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter alone → send. Shift+Enter or Cmd/Ctrl+Enter → newline.
    // (Cmd/Ctrl+Enter is also accepted as send for power users who set IME quirks.)
    if (e.key !== 'Enter') return
    if (e.shiftKey) return // newline
    // Block send while IME is composing (Chinese/Japanese/Korean input). React
    // doesn't expose isComposing on its synthetic event; reach for the native one.
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  return (
    <form onSubmit={submit} className="border-t border-slate-200 p-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask anything (Enter to send · Shift+Enter for newline)…"
        disabled={busy && !onStop}
        rows={3}
        className="block w-full resize-none rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-50"
        style={{ minHeight: MIN_HEIGHT_PX, maxHeight: MAX_HEIGHT_PX }}
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">
          {busy ? 'Agent thinking…' : ''}
        </span>
        <div className="flex items-center gap-2">
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded-md bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-300"
              aria-label="Stop the running agent"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!text.trim() || busy}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
