import { useState } from 'react'

interface FabProps {
  onClick: () => void
  position: 'bottom-right' | 'bottom-left'
}

export function Fab({ onClick, position }: FabProps) {
  const [hovered, setHovered] = useState(false)
  const posClass = position === 'bottom-right' ? 'right-4 bottom-4' : 'left-4 bottom-4'
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`fixed ${posClass} h-12 w-12 rounded-full bg-blue-600 text-white shadow-lg transition-transform hover:scale-110`}
      style={{ zIndex: 2147483647 }}
      aria-label="mycli-web toggle chat"
    >
      <span className="text-sm font-semibold">{hovered ? 'mw' : '▲'}</span>
    </button>
  )
}

export function ChatShell() {
  return (
    <div
      className="fixed right-4 bottom-20 h-96 w-80 rounded-lg border border-slate-200 bg-white shadow-xl"
      style={{ zIndex: 2147483647 }}
    >
      <div className="flex h-10 items-center border-b border-slate-200 px-3 text-sm font-semibold text-slate-700">
        mycli-web (Plan A stub)
      </div>
      <div className="flex h-[calc(100%-2.5rem)] items-center justify-center text-sm text-slate-400">
        Chat UI coming in Plan B
      </div>
    </div>
  )
}
