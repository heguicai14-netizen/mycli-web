import { describe, it, expect, vi } from 'vitest'
import { installHub } from '@ext/rpc/hub'
import { RpcClient } from '@ext/rpc/client'

describe('RPC hub (content ↔ SW)', () => {
  it('round-trips ping → pong with command/ack', async () => {
    installHub({ mode: 'echo' })
    const client = new RpcClient({ portName: 'session' })
    await client.connect()

    // Register pong handler BEFORE sending — the in-memory mock is synchronous,
    // so events fired during send() would arrive before a post-hoc listener attaches.
    const pongPromise = new Promise<any>((resolve) => {
      client.on('pong', resolve)
    })

    const ack = await client.send({ kind: 'ping' })
    expect(ack.ok).toBe(true)

    const pong = await pongPromise
    expect(pong.kind).toBe('pong')
    client.disconnect()
  })

  it('validates incoming client command against schema', async () => {
    installHub({ mode: 'echo' })
    const client = new RpcClient({ portName: 'session' })
    await client.connect()
    const bad = client.sendRaw({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      ts: Date.now(),
      kind: 'chat/send',
      // text missing
    } as any)
    const ack = await bad
    expect(ack.ok).toBe(false)
    expect(ack.error?.code).toBe('schema_invalid')
    client.disconnect()
  })
})

describe('RpcClient reconnect', () => {
  it('reconnects after port disconnect', async () => {
    vi.useFakeTimers()
    try {
      installHub({ mode: 'echo' })
      const client = new RpcClient({ portName: 'session', reconnect: true, ackTimeoutMs: 1000 })
      await client.connect()
      ;(client as any).port.disconnect()
      expect((client as any).connected).toBe(false)
      await vi.advanceTimersByTimeAsync(1100)
      // After reconnect, sending should work again.
      const ack = await client.send({ kind: 'ping' })
      expect(ack.ok).toBe(true)
      client.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})
