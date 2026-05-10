import { installKernelBackground } from 'agent-kernel'
import { setTransientUi, getTransientUi } from './storage/transient'

// mycli-web layers a transient `panelOpen` + per-tab `activatedTabs` flag on
// top of the kernel's default activate-on-tab behavior. Everything else
// (offscreen lifecycle, hub install, dom-op router, session storage widening,
// runtime-error fanout) is delegated to the kernel.
installKernelBackground({
  offscreenUrl: chrome.runtime.getURL('html/offscreen.html'),
  offscreenReason: 'IFRAME_SCRIPTING' as chrome.offscreen.Reason,
  hubMode: 'offscreen-forward',
  toggleCommand: 'toggle-chat',
  onActivate: async (tabId) => {
    const ui = await getTransientUi()
    const activatedTabs = { ...ui.activatedTabs, [String(tabId)]: true }
    await setTransientUi({ activatedTabs, panelOpen: true })
    try {
      await chrome.tabs.sendMessage(tabId, { kind: 'content/activate' })
    } catch {
      // content script not loaded yet (e.g. chrome:// pages); ignore
    }
  },
})
