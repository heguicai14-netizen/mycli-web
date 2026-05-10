// Multi-context chrome runtime mock.
//
// Models three kinds of contexts a single extension instance has:
//   'offscreen', 'sw', and `tab:${number}` for content scripts.
//
// Implements just enough of the broadcast transport used by the dom_op /
// chrome_api protocol to drive integration tests:
//
//   - chrome.runtime.sendMessage(msg) broadcasts to onMessage listeners in
//     every OTHER context (the sender's own context is skipped).
//   - chrome.tabs.sendMessage(tabId, msg, cb) delivers to the matching tab
//     context only. If no such context exists, lastError is set and the
//     callback fires with undefined (matches Chrome's "Receiving end does
//     not exist." error).
//   - listeners may call sendResponse synchronously; the response is captured
//     and forwarded to chrome.tabs.sendMessage's callback.
//
// Delivery is via queueMicrotask so registration ordering matches real Chrome.

type Listener = (msg: any, sender: any, sendResponse: (r: any) => void) => boolean | undefined | void

export type ContextId = 'offscreen' | 'sw' | `tab:${number}`

interface ContextState {
  id: ContextId
  onMessage: Set<Listener>
}

export class MultiContextBus {
  private contexts = new Map<ContextId, ContextState>()
  private currentContext: ContextId | null = null
  private lastError: { message: string } | undefined = undefined

  registerContext(id: ContextId): void {
    if (!this.contexts.has(id)) this.contexts.set(id, { id, onMessage: new Set() })
  }

  removeContext(id: ContextId): void {
    this.contexts.delete(id)
  }

  runIn<T>(id: ContextId, fn: () => T): T {
    this.registerContext(id)
    const prev = this.currentContext
    this.currentContext = id
    try {
      return fn()
    } finally {
      this.currentContext = prev
    }
  }

  private requireCurrentContext(): ContextId {
    if (!this.currentContext)
      throw new Error('chrome.* called outside any context — wrap in bus.runIn(...)')
    return this.currentContext
  }

  currentContextOrNull(): ContextId | null {
    return this.currentContext
  }

  install(): void {
    const bus = this

    ;(globalThis as any).chrome = {
      runtime: {
        get lastError() {
          return bus.lastError
        },
        sendMessage: (msg: any, cb?: (r: any) => void) => {
          // Sender is null when called from a .then() / setTimeout callback that
          // outlived its synchronous context. Real Chrome attributes such calls
          // to whatever context the JS is actually running in; for protocol
          // messages with unique correlation ids the self-echo doesn't matter
          // (listeners filter by kind/id).
          const sender = bus.currentContextOrNull()
          queueMicrotask(() => {
            for (const [ctxId, ctx] of bus.contexts) {
              if (ctxId === sender) continue
              for (const listener of [...ctx.onMessage]) {
                bus.invokeListener(ctx, listener, msg, { id: sender })
              }
            }
            cb?.(undefined)
          })
        },
        onMessage: {
          addListener: (cb: Listener) => {
            const ctx = bus.requireContextOrFail()
            ctx.onMessage.add(cb)
          },
          removeListener: (cb: Listener) => {
            const ctx = bus.requireContextOrFail()
            ctx.onMessage.delete(cb)
          },
        },
        connect: () => {
          throw new Error('chrome.runtime.connect not modeled in MultiContextBus')
        },
        onConnect: { addListener: () => {}, removeListener: () => {} },
      },
      tabs: {
        sendMessage: (tabId: number, msg: any, cb?: (r: any) => void) => {
          const sender = bus.requireCurrentContext()
          const tabCtxId = `tab:${tabId}` as ContextId
          queueMicrotask(() => {
            const tabCtx = bus.contexts.get(tabCtxId)
            if (!tabCtx || tabCtx.onMessage.size === 0) {
              // No content script in this tab — Chrome surfaces this via lastError
              // during the callback, then clears it.
              bus.lastError = { message: 'Receiving end does not exist.' }
              try {
                bus.runIn(sender, () => cb?.(undefined))
              } finally {
                bus.lastError = undefined
              }
              return
            }
            let response: any = undefined
            let didRespond = false
            const sendResponse = (r: any) => {
              if (didRespond) return
              response = r
              didRespond = true
            }
            for (const listener of [...tabCtx.onMessage]) {
              if (didRespond) break
              bus.invokeListener(tabCtx, listener, msg, { id: sender }, sendResponse)
            }
            if (didRespond) {
              bus.runIn(sender, () => cb?.(response))
            } else {
              bus.lastError = { message: 'The message port closed before a response was received.' }
              try {
                bus.runIn(sender, () => cb?.(undefined))
              } finally {
                bus.lastError = undefined
              }
            }
          })
        },
        query: async () => [],
      },
      storage: {
        local: emptyStorageArea(),
        session: emptyStorageArea(),
      },
    }
  }

  private requireContextOrFail(): ContextState {
    const id = this.requireCurrentContext()
    const ctx = this.contexts.get(id)
    if (!ctx) throw new Error(`context not registered: ${id}`)
    return ctx
  }

  private invokeListener(
    ctx: ContextState,
    listener: Listener,
    msg: any,
    sender: any,
    sendResponse: (r: any) => void = () => {},
  ): void {
    const prev = this.currentContext
    this.currentContext = ctx.id
    try {
      listener(msg, sender, sendResponse)
    } catch (e) {
      console.error(`[MultiContextBus] listener in ${ctx.id} threw:`, e)
    } finally {
      this.currentContext = prev
    }
  }
}

function emptyStorageArea() {
  const store = new Map<string, unknown>()
  return {
    get: async (keys?: string | string[]) => {
      if (keys === undefined) return Object.fromEntries(store)
      const arr = typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      for (const k of arr) if (store.has(k)) out[k] = store.get(k)
      return out
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v)
    },
    remove: async (keys: string | string[]) => {
      const arr = typeof keys === 'string' ? [keys] : keys
      for (const k of arr) store.delete(k)
    },
    clear: async () => store.clear(),
  }
}

export function installMultiContextChrome(): MultiContextBus {
  const bus = new MultiContextBus()
  bus.install()
  return bus
}
