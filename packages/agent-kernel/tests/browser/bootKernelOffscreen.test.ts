import { describe, it, expect, vi } from 'vitest'
import { bootKernelOffscreen } from 'agent-kernel'

describe('bootKernelOffscreen', () => {
  it('registers chrome.runtime.onConnect for "sw-to-offscreen" and accepts a port', () => {
    const onConnectListeners: Array<(port: any) => void> = []
    ;(globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: (cb: any) => onConnectListeners.push(cb) },
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        sendMessage: vi.fn(),
      },
    }

    bootKernelOffscreen({
      settings: { load: async () => ({ apiKey: 'k', baseUrl: 'b', model: 'm' }) },
      messageStore: {
        activeConversationId: async () => 'c',
        append: async () => ({ id: 'i', createdAt: 0 }),
        list: async () => [],
        update: async () => {},
      },
      toolContext: { build: async () => ({}) },
      tools: [],
    })

    // The port handler should be registered.
    expect(onConnectListeners.length).toBeGreaterThanOrEqual(1)

    // Simulate SW connecting via the expected port name.
    const port = {
      name: 'sw-to-offscreen',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    }
    onConnectListeners[0](port)
    expect(port.onMessage.addListener).toHaveBeenCalled()
    expect(port.onDisconnect.addListener).toHaveBeenCalled()
  })

  it('ignores ports with the wrong name', () => {
    const onConnectListeners: Array<(port: any) => void> = []
    ;(globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: (cb: any) => onConnectListeners.push(cb) },
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn(),
      },
    }
    bootKernelOffscreen({
      settings: { load: async () => ({ apiKey: 'k', baseUrl: 'b', model: 'm' }) },
      messageStore: {
        activeConversationId: async () => 'c',
        append: async () => ({ id: 'i', createdAt: 0 }),
        list: async () => [],
        update: async () => {},
      },
      toolContext: { build: async () => ({}) },
      tools: [],
    })
    const port = {
      name: 'something-else',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    }
    onConnectListeners[0](port)
    expect(port.onMessage.addListener).not.toHaveBeenCalled()
  })
})
