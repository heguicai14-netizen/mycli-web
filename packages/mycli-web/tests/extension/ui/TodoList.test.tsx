import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TodoList } from '@ext/ui/TodoList'
import type { TodoItem } from 'agent-kernel'

const item = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: overrides.id ?? 't1',
  subject: overrides.subject ?? 'Sample',
  status: overrides.status ?? 'pending',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe('TodoList', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(<TodoList items={[]} />)
    expect(container.querySelector('[data-testid="todo-list"]')).toBeNull()
  })

  it('renders each item with its subject', () => {
    render(
      <TodoList
        items={[
          item({ id: 't1', subject: 'First task' }),
          item({ id: 't2', subject: 'Second task' }),
        ]}
      />,
    )
    expect(screen.getByText('First task')).toBeTruthy()
    expect(screen.getByText('Second task')).toBeTruthy()
  })

  it('shows activeForm for in_progress items, subject otherwise', () => {
    render(
      <TodoList
        items={[
          item({ id: 't1', subject: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' }),
          item({ id: 't2', subject: 'Refactor', activeForm: 'Refactoring', status: 'pending' }),
        ]}
      />,
    )
    expect(screen.getByText('Writing tests')).toBeTruthy()
    expect(screen.getByText('Refactor')).toBeTruthy()
    expect(screen.queryByText('Refactoring')).toBeNull()
  })

  it('renders status indicators for each status', () => {
    const { container } = render(
      <TodoList
        items={[
          item({ id: 't1', subject: 'A', status: 'pending' }),
          item({ id: 't2', subject: 'B', status: 'in_progress' }),
          item({ id: 't3', subject: 'C', status: 'completed' }),
        ]}
      />,
    )
    expect(container.querySelector('[data-status="pending"]')).toBeTruthy()
    expect(container.querySelector('[data-status="in_progress"]')).toBeTruthy()
    expect(container.querySelector('[data-status="completed"]')).toBeTruthy()
  })
})
