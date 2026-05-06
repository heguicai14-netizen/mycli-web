import { installHub } from './rpc/hub'
import { setTransientUi, getTransientUi } from './storage/transient'

const OFFSCREEN_URL = chrome.runtime.getURL('html/offscreen.html')

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [OFFSCREEN_URL],
  })
  if (contexts.length > 0) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['IFRAME_SCRIPTING' as chrome.offscreen.Reason],
    justification: 'Host agent runtime and sandbox iframes for code-capable skills.',
  })
}

async function activateOnTab(tabId: number): Promise<void> {
  await ensureOffscreen()
  const ui = await getTransientUi()
  const activatedTabs = { ...ui.activatedTabs, [String(tabId)]: true }
  await setTransientUi({ activatedTabs, panelOpen: true })
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'content/activate' })
  } catch {
    // content script not loaded yet (e.g. chrome:// pages); ignore
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureOffscreen()
})

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen()
})

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) await activateOnTab(tab.id)
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-chat') return
  if (tab?.id) await activateOnTab(tab.id)
})

// chrome.storage.session defaults to TRUSTED_CONTEXTS only (= no content scripts).
// Content scripts need to read/write transient UI state (panelOpen, etc.), so widen
// the access level here at SW startup. Idempotent — safe to call on every boot.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((e) => console.warn('[mycli-web] failed to widen session storage access:', e))

installHub({ mode: 'offscreen-forward' })

// DOM op routing: offscreen → SW → target tab → result back to offscreen.
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg?.kind === 'dom_op_request') {
    const { id, op } = msg
    const tabId = op?.tabId
    if (typeof tabId !== 'number') {
      chrome.runtime.sendMessage({
        kind: 'dom_op_result',
        id,
        result: {
          ok: false,
          error: { code: 'no_tab', message: 'op missing tabId', retryable: false },
        },
      })
      return false
    }
    chrome.tabs.sendMessage(tabId, { kind: 'dom_op', id, op }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({
          kind: 'dom_op_result',
          id,
          result: {
            ok: false,
            error: {
              code: 'tab_unreachable',
              message: chrome.runtime.lastError.message ?? '',
              retryable: true,
            },
          },
        })
        return
      }
      chrome.runtime.sendMessage({ kind: 'dom_op_result', id, result: response })
    })
    return true
  }
  if (msg?.kind === 'chrome_api_request') {
    const { id, method, args } = msg
    handleChromeApi(method, args).then((result) =>
      chrome.runtime.sendMessage({ kind: 'chrome_api_result', id, result }),
    )
    return true
  }
  return false
})

async function handleChromeApi(method: string, args: any[]) {
  try {
    if (method === 'tabs.query') {
      const tabs = await chrome.tabs.query(args[0] ?? {})
      return {
        ok: true,
        data: {
          tabs: tabs.map((t) => ({
            id: t.id ?? -1,
            url: t.url ?? '',
            title: t.title ?? '',
            active: t.active,
          })),
        },
      }
    }
    if (method === 'tabs.captureVisibleTab') {
      const dataUrl = await chrome.tabs.captureVisibleTab()
      return { ok: true, data: { dataUrl } }
    }
    return {
      ok: false,
      error: { code: 'unknown_method', message: method, retryable: false },
    }
  } catch (e: any) {
    return {
      ok: false,
      error: { code: 'chrome_api_error', message: e?.message ?? String(e), retryable: true },
    }
  }
}

console.log('[mycli-web] background SW booted')
