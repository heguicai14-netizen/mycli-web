// Polyfill for chrome.* APIs that aren't exposed inside offscreen documents
// in some Chrome versions (chrome.storage and chrome.tabs in particular).
// Routes the missing surfaces through the SW via the existing chrome_api
// broadcast transport (see ./domOpRouter.ts on the SW side).
//
// Must be invoked at the very top of offscreen.ts, before any module-level
// or runtime call site touches chrome.storage / chrome.tabs.

import { callChromeApi } from './domOpClient'

async function unwrap<T>(method: string, args: unknown[]): Promise<T> {
  const r = await callChromeApi(method, args)
  if (!r?.ok) {
    const err = r?.error ?? { code: 'unknown', message: 'no result' }
    throw new Error(`${method} via chrome_api failed: ${err.code}: ${err.message}`)
  }
  return r.data as T
}

export function polyfillChromeApiInOffscreen(): void {
  const c = globalThis.chrome as any
  if (!c) {
    // Truly no chrome object — nothing to polyfill (and offscreen wouldn't work anyway).
    return
  }

  if (!c.storage) {
    console.warn('[mycli-web/offscreen] chrome.storage missing — installing SW proxy polyfill')
    c.storage = {
      local: {
        get: (keys?: any) => unwrap<Record<string, unknown>>('storage.local.get', [keys]),
        set: (items: Record<string, unknown>) =>
          unwrap<undefined>('storage.local.set', [items]),
        remove: (keys: string | string[]) =>
          unwrap<undefined>('storage.local.remove', [keys]),
      },
      session: {
        get: (keys?: any) => unwrap<Record<string, unknown>>('storage.session.get', [keys]),
        set: (items: Record<string, unknown>) =>
          unwrap<undefined>('storage.session.set', [items]),
        remove: (keys: string | string[]) =>
          unwrap<undefined>('storage.session.remove', [keys]),
      },
    }
  }

  if (!c.tabs) {
    console.warn('[mycli-web/offscreen] chrome.tabs missing — installing SW proxy polyfill')
    c.tabs = {
      query: async (queryInfo: chrome.tabs.QueryInfo) => {
        const data = await unwrap<{
          tabs: Array<{ id: number; url: string; title: string; active: boolean }>
        }>('tabs.query', [queryInfo])
        // Return shape matches chrome.tabs.Tab loosely. Only the fields used by
        // call sites in this codebase (id, url, title, active) are populated.
        return data.tabs as unknown as chrome.tabs.Tab[]
      },
    }
  }
}
