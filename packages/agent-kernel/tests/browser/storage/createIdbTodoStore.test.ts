import { describe, it, expect, beforeEach } from 'vitest'
import { createIdbTodoStore } from 'agent-kernel'
import { openDb, resetDbForTests } from 'agent-kernel'

beforeEach(async () => {
  await resetDbForTests()
})

describe('createIdbTodoStore', () => {
  it('list returns empty array for a conversation with no todos', async () => {
    const store = await createIdbTodoStore(await openDb())
    const items = await store.list('c1')
    expect(items).toEqual([])
  })

  it('replace inserts new items with generated ids and timestamps', async () => {
    const store = await createIdbTodoStore(await openDb())
    const before = Date.now()
    const result = await store.replace('c1', [
      { subject: 'A', status: 'pending' },
      { subject: 'B', status: 'in_progress', activeForm: 'Doing B' },
    ])
    const after = Date.now()
    expect(result).toHaveLength(2)
    expect(result[0].id).toBeTypeOf('string')
    expect(result[0].id.length).toBeGreaterThan(0)
    expect(result[0].id).not.toBe(result[1].id)
    expect(result[0].subject).toBe('A')
    expect(result[0].status).toBe('pending')
    expect(result[1].activeForm).toBe('Doing B')
    expect(result[0].createdAt).toBeGreaterThanOrEqual(before)
    expect(result[0].createdAt).toBeLessThanOrEqual(after)
    expect(result[0].updatedAt).toBe(result[0].createdAt)
  })

  it('replace preserves id + createdAt when input has an id', async () => {
    const store = await createIdbTodoStore(await openDb())
    const first = await store.replace('c1', [{ subject: 'A', status: 'pending' }])
    const originalId = first[0].id
    const originalCreatedAt = first[0].createdAt
    await new Promise((r) => setTimeout(r, 5))
    const second = await store.replace('c1', [
      { id: originalId, subject: 'A revised', status: 'in_progress' },
    ])
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(originalId)
    expect(second[0].createdAt).toBe(originalCreatedAt)
    expect(second[0].updatedAt).toBeGreaterThan(originalCreatedAt)
    expect(second[0].subject).toBe('A revised')
    expect(second[0].status).toBe('in_progress')
  })

  it('replace removes items absent from new input', async () => {
    const store = await createIdbTodoStore(await openDb())
    const first = await store.replace('c1', [
      { subject: 'A', status: 'pending' },
      { subject: 'B', status: 'pending' },
    ])
    const second = await store.replace('c1', [
      { id: first[0].id, subject: 'A', status: 'completed' },
    ])
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(first[0].id)
    const listed = await store.list('c1')
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(first[0].id)
  })

  it('replace with empty array clears the list', async () => {
    const store = await createIdbTodoStore(await openDb())
    await store.replace('c1', [{ subject: 'A', status: 'pending' }])
    const cleared = await store.replace('c1', [])
    expect(cleared).toEqual([])
    expect(await store.list('c1')).toEqual([])
  })

  it('list is isolated by conversationId', async () => {
    const store = await createIdbTodoStore(await openDb())
    await store.replace('c1', [{ subject: 'A', status: 'pending' }])
    await store.replace('c2', [{ subject: 'B', status: 'pending' }])
    const c1Items = await store.list('c1')
    const c2Items = await store.list('c2')
    expect(c1Items).toHaveLength(1)
    expect(c2Items).toHaveLength(1)
    expect(c1Items[0].subject).toBe('A')
    expect(c2Items[0].subject).toBe('B')
  })
})
