import { describe, it, expect, beforeEach } from 'vitest'
import {
  resetDbForTests,
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
} from 'agent-kernel'

describe('conversations store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('creates, fetches, lists, updates, and deletes', async () => {
    const created = await createConversation({ title: 'first' })
    expect(created.id).toMatch(/[0-9a-f-]{36}/i)
    expect(created.title).toBe('first')
    expect(created.compactionCount).toBe(0)

    const fetched = await getConversation(created.id)
    expect(fetched?.title).toBe('first')

    await createConversation({ title: 'second' })
    const list = await listConversations()
    expect(list.length).toBe(2)
    expect(list.map((c) => c.title).sort()).toEqual(['first', 'second'])

    await updateConversation(created.id, { title: 'first (edited)' })
    const reloaded = await getConversation(created.id)
    expect(reloaded?.title).toBe('first (edited)')
    expect(reloaded!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    await deleteConversation(created.id)
    expect(await getConversation(created.id)).toBeUndefined()
  })

  it('sorts listConversations by updatedAt desc', async () => {
    const a = await createConversation({ title: 'a' })
    await new Promise((r) => setTimeout(r, 2))
    const b = await createConversation({ title: 'b' })
    await new Promise((r) => setTimeout(r, 2))
    await updateConversation(a.id, { title: 'a2' })
    const list = await listConversations()
    expect(list[0].id).toBe(a.id)
    expect(list[1].id).toBe(b.id)
  })
})
