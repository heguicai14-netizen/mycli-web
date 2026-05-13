import type { TodoItem } from 'agent-kernel'

export interface TodoListProps {
  items: TodoItem[]
}

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  pending: '☐',
  in_progress: '▶',
  completed: '✓',
}

export function TodoList({ items }: TodoListProps) {
  if (items.length === 0) return null
  return (
    <div
      data-testid="todo-list"
      style={{
        padding: 8,
        borderRadius: 6,
        background: 'rgba(0,0,0,0.04)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Todo</div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {items.map((item) => (
          <li
            key={item.id}
            data-status={item.status}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              padding: '2px 0',
              opacity: item.status === 'completed' ? 0.5 : 1,
              textDecoration: item.status === 'completed' ? 'line-through' : 'none',
            }}
          >
            <span aria-hidden="true">{STATUS_GLYPH[item.status]}</span>
            <span>
              {item.status === 'in_progress' && item.activeForm
                ? item.activeForm
                : item.subject}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
