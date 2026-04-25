type Listener<T = any> = (...args: any[]) => T

interface PortEndpoint {
  name: string
  listeners: Set<Listener>
  disconnectListeners: Set<Listener>
  remote?: PortEndpoint
  disconnected: boolean
}

function createPortPair(name: string) {
  const a: PortEndpoint = { name, listeners: new Set(), disconnectListeners: new Set(), disconnected: false }
  const b: PortEndpoint = { name, listeners: new Set(), disconnectListeners: new Set(), disconnected: false }
  a.remote = b
  b.remote = a
  return [a, b] as const
}

function asPort(ep: PortEndpoint): chrome.runtime.Port {
  return {
    name: ep.name,
    onMessage: {
      addListener: (cb: Listener) => ep.listeners.add(cb),
      removeListener: (cb: Listener) => ep.listeners.delete(cb),
      hasListener: (cb: Listener) => ep.listeners.has(cb),
    } as any,
    onDisconnect: {
      addListener: (cb: Listener) => ep.disconnectListeners.add(cb),
      removeListener: (cb: Listener) => ep.disconnectListeners.delete(cb),
      hasListener: (cb: Listener) => ep.disconnectListeners.has(cb),
    } as any,
    postMessage: (msg: unknown) => {
      if (ep.disconnected || !ep.remote) return
      for (const cb of ep.remote.listeners) cb(msg, asPort(ep.remote))
    },
    disconnect: () => {
      if (ep.disconnected) return
      ep.disconnected = true
      // Fire OWN listeners — simulates "connection torn down from this end's perspective".
      // This deviates slightly from Chrome (Chrome doesn't fire own listeners when you call
      // disconnect yourself), but for tests that want to simulate "the port broke" it's the
      // simplest way to drive the client's reconnect path without exposing server-side ports.
      for (const cb of ep.disconnectListeners) cb(asPort(ep))
      if (ep.remote && !ep.remote.disconnected) {
        ep.remote.disconnected = true
        for (const cb of ep.remote.disconnectListeners) cb(asPort(ep.remote))
      }
    },
    sender: {},
  } as any
}

export function installChromeMock() {
  const connectListeners = new Set<Listener>()
  const storageLocal = new Map<string, unknown>()
  const storageSession = new Map<string, unknown>()

  ;(globalThis as any).chrome = {
    runtime: {
      connect: ({ name }: { name: string }) => {
        const [clientEnd, serverEnd] = createPortPair(name)
        queueMicrotask(() => {
          for (const cb of connectListeners) cb(asPort(serverEnd))
        })
        return asPort(clientEnd)
      },
      onConnect: {
        addListener: (cb: Listener) => connectListeners.add(cb),
        removeListener: (cb: Listener) => connectListeners.delete(cb),
        hasListener: (cb: Listener) => connectListeners.has(cb),
      },
      sendMessage: (_msg: unknown, cb?: Listener) => {
        cb?.()
      },
      onMessage: {
        addListener: () => {},
        removeListener: () => {},
      },
      lastError: undefined,
    },
    storage: {
      local: {
        get: async (keys?: string | string[] | Record<string, unknown>) => {
          if (keys === undefined) return Object.fromEntries(storageLocal)
          const keyArr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
          const out: Record<string, unknown> = {}
          for (const k of keyArr) if (storageLocal.has(k)) out[k] = storageLocal.get(k)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storageLocal.set(k, v)
        },
        remove: async (keys: string | string[]) => {
          const arr = typeof keys === 'string' ? [keys] : keys
          for (const k of arr) storageLocal.delete(k)
        },
        clear: async () => storageLocal.clear(),
      },
      session: {
        get: async (keys?: string | string[]) => {
          if (keys === undefined) return Object.fromEntries(storageSession)
          const arr = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const k of arr) if (storageSession.has(k)) out[k] = storageSession.get(k)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storageSession.set(k, v)
        },
        remove: async (keys: string | string[]) => {
          const arr = typeof keys === 'string' ? [keys] : keys
          for (const k of arr) storageSession.delete(k)
        },
        clear: async () => storageSession.clear(),
      },
    },
    tabs: {
      query: async () => [],
    },
    scripting: {
      executeScript: async () => [],
    },
  }
}
