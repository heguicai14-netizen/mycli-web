import { describe, it, expect } from 'vitest'
import { wrapForRecord } from '../../../eval/replay/recorder'
import { wrapForReplay } from '../../../eval/replay/player'

const realLlm = {
  async *streamChat() {
    yield { kind: 'delta', text: 'hello' }
    yield { kind: 'done', stopReason: 'stop', usage: { in: 5, out: 1 } }
  },
} as any

describe('record + replay round-trip', () => {
  it('replay emits the same events the real client did during record', async () => {
    const store = new Map<string, unknown[]>()
    const recorded = wrapForRecord(realLlm, 'task-A', { put: (k, v) => store.set(k, v) })
    const evRecorded: any[] = []
    for await (const ev of recorded.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) evRecorded.push(ev)

    const replayed = wrapForReplay('task-A', { get: (k) => store.get(k) })
    const evReplayed: any[] = []
    for await (const ev of replayed.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) evReplayed.push(ev)
    expect(evReplayed).toEqual(evRecorded)
  })

  it('replay throws when request hash differs from recorded', async () => {
    const store = new Map<string, unknown[]>()
    const rec = wrapForRecord(realLlm, 'task-A', { put: (k, v) => store.set(k, v) })
    for await (const _ of rec.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    const replay = wrapForReplay('task-A', { get: (k) => store.get(k) })
    let threw = false
    try {
      for await (const _ of replay.streamChat({ messages: [{ role: 'user', content: 'CHANGED' }] })) { /* */ }
    } catch (e: any) {
      threw = true
      expect(e.message).toMatch(/hash/i)
    }
    expect(threw).toBe(true)
  })
})
