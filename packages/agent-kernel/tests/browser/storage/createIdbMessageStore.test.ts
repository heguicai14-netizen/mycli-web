import { describe, it, expect, beforeEach } from 'vitest'
import { createIdbMessageStore, resetDbForTests } from 'agent-kernel'

describe('createIdbMessageStore — multi-conversation', () => {
  beforeEach(async () => {
    await resetDbForTests()
    await chrome.storage.local.clear()
  })

  it('lazy-creates a conversation on first activeConversationId() call', async () => {
    const store = createIdbMessageStore()
    const id1 = await store.activeConversationId()
    expect(id1).toMatch(/[0-9a-f-]{36}/i)
    // Subsequent calls return the same one (now stored in latest-list).
    const id2 = await store.activeConversationId()
    expect(id2).toBe(id1)
  })

  it('createConversation() makes a new one and sets it as active', async () => {
    const store = createIdbMessageStore()
    const a = await store.createConversation!({ title: 'A' })
    // Tiny delay so Date.now() advances at least 1ms — list-sort order is by
    // updatedAt and two same-ms creates would otherwise be non-deterministic.
    await new Promise((r) => setTimeout(r, 2))
    const b = await store.createConversation!({ title: 'B' })
    // Newly created should immediately be the active one.
    expect(await store.activeConversationId()).toBe(b.id)
    // List sees both, sorted by updatedAt desc.
    const all = await store.listConversations!()
    expect(all.map((c) => c.id)).toEqual([b.id, a.id])
  })

  it('setActiveConversationId() persists across store instances (chrome.storage.local)', async () => {
    const store1 = createIdbMessageStore()
    const a = await store1.createConversation!({ title: 'A' })
    const b = await store1.createConversation!({ title: 'B' })
    // active is now b after creation. Switch back to a.
    await store1.setActiveConversationId!(a.id)
    expect(await store1.activeConversationId()).toBe(a.id)
    // A second store instance sees the same active.
    const store2 = createIdbMessageStore()
    expect(await store2.activeConversationId()).toBe(a.id)
  })

  it('deleteConversation() removes the row + its messages + clears active if it was active', async () => {
    const store = createIdbMessageStore()
    const a = await store.createConversation!({ title: 'A' })
    const b = await store.createConversation!({ title: 'B' })
    await store.append({ conversationId: a.id, role: 'user', content: 'hi a' })
    await store.append({ conversationId: b.id, role: 'user', content: 'hi b' })
    expect((await store.list(a.id)).length).toBe(1)

    // active is b (most recent created). Delete a (NOT the active one).
    await store.deleteConversation!(a.id)
    expect((await store.listConversations!()).map((c) => c.id)).toEqual([b.id])
    // active stays b.
    expect(await store.activeConversationId()).toBe(b.id)

    // Now delete the active one. activeConversationId() should fall back to
    // "latest" (none left here, so it lazy-creates a new one).
    await store.deleteConversation!(b.id)
    const fresh = await store.activeConversationId()
    expect(fresh).not.toBe(b.id)
    expect((await store.listConversations!()).length).toBe(1)
  })

  it('activeConversationId() heals stale stored active by falling back to latest', async () => {
    const store = createIdbMessageStore()
    const a = await store.createConversation!({ title: 'A' })
    // Manually point chrome.storage.local at a non-existent id.
    await chrome.storage.local.set({
      'agent-kernel-active-conversation-id': '00000000-0000-0000-0000-000000000000',
    })
    // Should detect and clear, then fall back to a.
    expect(await store.activeConversationId()).toBe(a.id)
    const stored = (await chrome.storage.local.get('agent-kernel-active-conversation-id'))[
      'agent-kernel-active-conversation-id'
    ]
    expect(stored).toBeUndefined()
  })
})
