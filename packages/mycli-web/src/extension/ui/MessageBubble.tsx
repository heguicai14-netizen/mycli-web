import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  role: 'user' | 'assistant' | 'tool'
  content: string
  pending?: boolean
}

export function MessageBubble({ role, content, pending }: Props) {
  const isUser = role === 'user'
  const showPlaceholder = !content && pending
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900'
        }`}
      >
        {showPlaceholder ? (
          <span className="opacity-50">…</span>
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {pending && content && <span className="ml-1 animate-pulse">▍</span>}
      </div>
    </div>
  )
}
