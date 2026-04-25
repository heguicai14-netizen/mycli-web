import { useState, type FormEvent } from 'react'

interface Props {
  onSend: (text: string) => void
  disabled?: boolean
}

export function Composer({ onSend, disabled }: Props) {
  const [text, setText] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || disabled) return
    onSend(text.trim())
    setText('')
  }
  return (
    <form onSubmit={submit} className="border-t border-slate-200 p-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e as any)
        }}
        placeholder="Ask anything (Cmd/Ctrl+Enter to send)…"
        disabled={disabled}
        className="block h-16 w-full resize-none rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
      />
      <div className="mt-1 flex justify-end">
        <button
          type="submit"
          disabled={!text.trim() || disabled}
          className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </form>
  )
}
