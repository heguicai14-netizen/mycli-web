import { useState } from 'react'

export interface ConversationItem {
  id: string
  title: string
  updatedAt: number
}

interface Props {
  conversations: ConversationItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
  onClose: () => void
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  return `${mo}mo ago`
}

function previewTitle(t: string): string {
  // Trim and cap so wrapping doesn't blow the row out.
  const stripped = t.trim() || 'Untitled'
  return stripped.length > 60 ? stripped.slice(0, 60) + '…' : stripped
}

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onDelete,
  onNew,
  onClose,
}: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null)

  return (
    <div
      className="absolute top-10 left-2 z-10 max-h-80 w-80 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
        <span className="text-xs font-semibold text-slate-700">
          Conversations ({conversations.length})
        </span>
        <button
          type="button"
          onClick={() => {
            onNew()
            onClose()
          }}
          className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          + New
        </button>
      </div>

      {conversations.length === 0 ? (
        <div className="p-4 text-center text-xs text-slate-500">
          No conversations yet.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {conversations.map((c) => {
            const isActive = c.id === activeId
            const isConfirming = confirmId === c.id
            return (
              <li
                key={c.id}
                className={`group flex items-center gap-2 px-3 py-2 ${
                  isActive ? 'bg-blue-50' : 'hover:bg-slate-50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!isActive) onSelect(c.id)
                    onClose()
                  }}
                  className="flex flex-1 flex-col items-start text-left"
                >
                  <span
                    className={`text-xs ${
                      isActive ? 'font-semibold text-blue-700' : 'text-slate-700'
                    }`}
                  >
                    {previewTitle(c.title)}
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {relativeTime(c.updatedAt)}
                  </span>
                </button>
                {isConfirming ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(c.id)
                        setConfirmId(null)
                      }}
                      className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-red-700"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmId(null)
                      }}
                      className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-100"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmId(c.id)
                    }}
                    className="invisible rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-red-100 hover:text-red-700 group-hover:visible"
                    aria-label="Delete conversation"
                    title="Delete"
                  >
                    🗑
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
