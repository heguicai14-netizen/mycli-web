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

installHub({ mode: 'echo' })

console.log('[mycli-web] background SW booted')
