import { describe, it, expect } from 'vitest'
import { InMemoryTodoStore } from '../core/adapters/inMemoryTodoStore'

describe('InMemoryTodoStore', () => {
  it('list returns [] for unknown cid', async () => {
    const s = new InMemoryTodoStore()
    expect(await s.list('cid' as any)).toEqual([])
  })

  it('replace + list round-trip', async () => {
    const s = new InMemoryTodoStore()
    const items = await s.replace('cid' as any, [
      { subject: 'a', status: 'pending' },
      { subject: 'b', status: 'pending' },
    ])
    expect(items).toHaveLength(2)
    expect(items[0].id).toBeDefined()
    expect(items[0].createdAt).toBeGreaterThan(0)
    expect(await s.list('cid' as any)).toEqual(items)
  })

  it('replace preserves id + createdAt when id matches', async () => {
    const s = new InMemoryTodoStore()
    const r1 = await s.replace('cid' as any, [{ subject: 'a', status: 'pending' }])
    const id = r1[0].id
    const createdAt = r1[0].createdAt
    await new Promise((res) => setTimeout(res, 5))
    const r2 = await s.replace('cid' as any, [{ id, subject: 'a', status: 'completed' }])
    expect(r2[0].id).toBe(id)
    expect(r2[0].createdAt).toBe(createdAt)
    expect(r2[0].status).toBe('completed')
    expect(r2[0].updatedAt).toBeGreaterThan(createdAt)
  })

  it('replace with empty array deletes the entry', async () => {
    const s = new InMemoryTodoStore()
    await s.replace('cid' as any, [{ subject: 'a', status: 'pending' }])
    await s.replace('cid' as any, [])
    expect(await s.list('cid' as any)).toEqual([])
  })

  it('different cids are isolated', async () => {
    const s = new InMemoryTodoStore()
    await s.replace('cid1' as any, [{ subject: 'a', status: 'pending' }])
    await s.replace('cid2' as any, [{ subject: 'b', status: 'pending' }])
    expect(await s.list('cid1' as any)).toHaveLength(1)
    expect(await s.list('cid2' as any)).toHaveLength(1)
  })
})
