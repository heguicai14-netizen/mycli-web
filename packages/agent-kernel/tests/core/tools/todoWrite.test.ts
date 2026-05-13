import { describe, it, expect, vi } from 'vitest'
import { todoWriteTool, type TodoStoreAdapter, type TodoItem } from 'agent-kernel'

const stubStore = (overrides: Partial<TodoStoreAdapter> = {}): TodoStoreAdapter => ({
  list: vi.fn().mockResolvedValue([]),
  replace: vi.fn().mockResolvedValue([]),
  ...overrides,
})

describe('todoWriteTool', () => {
  it('calls store.replace with conversationId and items, returns canonical state', async () => {
    const canonical: TodoItem[] = [
      { id: 't1', subject: 'A', status: 'pending', createdAt: 1, updatedAt: 2 },
    ]
    const store = stubStore({ replace: vi.fn().mockResolvedValue(canonical) })
    const res = await todoWriteTool.execute(
      { items: [{ subject: 'A', status: 'pending' }] },
      { todoStore: store, conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.count).toBe(1)
      expect(res.data.items).toEqual(canonical)
    }
    expect(store.replace).toHaveBeenCalledWith('c1', [{ subject: 'A', status: 'pending' }])
  })

  it('returns makeError when todoStore is missing', async () => {
    const res = await todoWriteTool.execute(
      { items: [] },
      { conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('todo_unavailable')
    }
  })

  it('returns makeError when conversationId is missing (ephemeral turn)', async () => {
    const store = stubStore()
    const res = await todoWriteTool.execute(
      { items: [] },
      { todoStore: store } as any,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('no_conversation')
    }
    expect(store.replace).not.toHaveBeenCalled()
  })

  it('accepts an empty items array (clears the list)', async () => {
    const store = stubStore({ replace: vi.fn().mockResolvedValue([]) })
    const res = await todoWriteTool.execute(
      { items: [] },
      { todoStore: store, conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.count).toBe(0)
      expect(res.data.items).toEqual([])
    }
    expect(store.replace).toHaveBeenCalledWith('c1', [])
  })

  it('propagates store.replace errors as makeError', async () => {
    const store = stubStore({
      replace: vi.fn().mockRejectedValue(new Error('idb boom')),
    })
    const res = await todoWriteTool.execute(
      { items: [{ subject: 'A', status: 'pending' }] },
      { todoStore: store, conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('todo_persist_failed')
      expect(res.error.message).toMatch(/idb boom/)
      expect(res.error.retryable).toBe(true)
    }
  })
})
