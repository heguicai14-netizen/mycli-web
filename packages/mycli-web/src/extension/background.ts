import { installHub } from './rpc/hub'
import { setTransientUi, getTransientUi } from './storage/transient'
import { installDomOpRouter } from './domOpRouter'

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

const hub = installHub({ mode: 'offscreen-forward' })
installDomOpRouter()

self.addEventListener('error', (e: any) => {
  hub.broadcastRuntimeError(e?.message ?? 'uncaught error', e?.error?.stack)
})
self.addEventListener('unhandledrejection', (e: any) => {
  const reason = e?.reason
  const message =
    typeof reason === 'string' ? reason : reason?.message ?? 'unhandled rejection'
  hub.broadcastRuntimeError(message, reason?.stack)
})

console.log('[mycli-web] background SW booted')
