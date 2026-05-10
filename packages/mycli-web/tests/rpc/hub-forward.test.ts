import { describe, it, expect } from 'vitest'
import { installHub } from '@ext/rpc/hub'
import { RpcClient } from '@ext/rpc/client'

describe('hub offscreen-forward mode', () => {
  it('forwards ClientCmd to offscreen and routes events back by sessionId', async () => {
    installHub({ mode: 'offscreen-forward' })

    // Simulate a fake offscreen process. Attach the message listener SYNCHRONOUSLY
    // when the port arrives via onConnect — otherwise the hub's pending
    // postMessage microtask races ahead and the cmd is delivered before any
    // listener exists on the receiving endpoint.
    const messages: any[] = []
    const offscreenSidePromise = new Promise<chrome.runtime.Port>((resolve) => {
      chrome.runtime.onConnect.addListener((p) => {
        if (p.name === 'sw-to-offscreen') {
          p.onMessage.addListener((m) => messages.push(m))
          resolve(p)
        }
      })
    })

    const client = new RpcClient({ portName: 'session', ackTimeoutMs: 1000, reconnect: false })
    await client.connect()
    const ack = await client.send({ kind: 'chat/send', text: 'hello' })
    expect(ack.ok).toBe(true)

    const offscreenPort = await offscreenSidePromise
    // Drain pending microtasks
    await new Promise((r) => setTimeout(r, 5))
    const cmd = messages.find((m) => m?.kind === 'chat/send')
    expect(cmd).toBeDefined()
    expect(cmd.text).toBe('hello')

    // Simulate offscreen → SW event for that session
    const evtPromise = new Promise<any>((resolve) => {
      client.on('message/streamChunk', resolve)
    })
    offscreenPort.postMessage({
      id: crypto.randomUUID(),
      sessionId: client.sessionId,
      ts: Date.now(),
      kind: 'message/streamChunk',
      messageId: crypto.randomUUID(),
      delta: 'hi',
    })
    const evt = await evtPromise
    expect(evt.delta).toBe('hi')

    client.disconnect()
  })
})
