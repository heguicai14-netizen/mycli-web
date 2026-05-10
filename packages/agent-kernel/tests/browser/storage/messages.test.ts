import { describe, it, expect, beforeEach } from 'vitest'
import {
  resetDbForTests,
  createConversation,
  appendMessage,
  listMessagesByConversation,
  markMessagesCompacted,
  updateMessage,
  deleteMessagesByConversation,
} from 'agent-kernel'

describe('messages store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('appends messages with monotonic seq within a conversation', async () => {
    const c = await createConversation({ title: 'a' })
    const m1 = await appendMessage({ conversationId: c.id, role: 'user', content: 'hi' })
    const m2 = await appendMessage({ conversationId: c.id, role: 'assistant', content: 'hello' })
    expect(m1.seq).toBe(0)
    expect(m2.seq).toBe(1)
  })

  it('lists messages in seq order', async () => {
    const c = await createConversation({ title: 'a' })
    await appendMessage({ conversationId: c.id, role: 'user', content: 'a' })
    await appendMessage({ conversationId: c.id, role: 'assistant', content: 'b' })
    await appendMessage({ conversationId: c.id, role: 'user', content: 'c' })
    const list = await listMessagesByConversation(c.id)
    expect(list.map((m) => m.content)).toEqual(['a', 'b', 'c'])
  })

  it('seq is per-conversation, not global', async () => {
    const c1 = await createConversation({ title: '1' })
    const c2 = await createConversation({ title: '2' })
    const m1 = await appendMessage({ conversationId: c1.id, role: 'user', content: 'x' })
    const m2 = await appendMessage({ conversationId: c2.id, role: 'user', content: 'y' })
    expect(m1.seq).toBe(0)
    expect(m2.seq).toBe(0)
  })

  it('markMessagesCompacted sets compacted flag', async () => {
    const c = await createConversation({ title: 'a' })
    const m1 = await appendMessage({ conversationId: c.id, role: 'user', content: 'a' })
    const m2 = await appendMessage({ conversationId: c.id, role: 'assistant', content: 'b' })
    await markMessagesCompacted([m1.id, m2.id])
    const list = await listMessagesByConversation(c.id)
    expect(list.every((m) => m.compacted)).toBe(true)
  })

  it('updateMessage patches fields except id/conversationId/seq', async () => {
    const c = await createConversation({ title: 'a' })
    const m = await appendMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'partial',
      pending: true,
    })
    await updateMessage(m.id, { content: 'final', pending: false })
    const list = await listMessagesByConversation(c.id)
    expect(list[0].content).toBe('final')
    expect(list[0].pending).toBe(false)
    expect(list[0].seq).toBe(m.seq)
  })

  it('deleteMessagesByConversation clears only target conversation', async () => {
    const c1 = await createConversation({ title: '1' })
    const c2 = await createConversation({ title: '2' })
    await appendMessage({ conversationId: c1.id, role: 'user', content: 'x' })
    await appendMessage({ conversationId: c2.id, role: 'user', content: 'y' })
    await deleteMessagesByConversation(c1.id)
    expect((await listMessagesByConversation(c1.id)).length).toBe(0)
    expect((await listMessagesByConversation(c2.id)).length).toBe(1)
  })
})
