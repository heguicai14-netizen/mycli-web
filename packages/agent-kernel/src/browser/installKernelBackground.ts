// Service-worker side bootstrap for the kernel. Encapsulates the standard
// MV3 wiring that every kernel consumer needs: ensure the offscreen document
// exists, install the hub + DOM-op router, bind the action click and an
// optional toggle keyboard command to "activate on tab", widen
// chrome.storage.session for content-script reads, and forward SW-side
// uncaught errors / unhandled rejections through the hub for F12 visibility.
//
// Consumers replace their entire background.ts with a single call to
// installKernelBackground(). The onActivate hook lets them layer extra
// behavior (e.g. set a transient `panelOpen` flag) without re-implementing
// the offscreen lifecycle plumbing.

import { installHub } from './rpc/hub'
import { installDomOpRouter } from './domOpRouter'

export interface InstallKernelBackgroundOptions {
  /** chrome.runtime.getURL('html/offscreen.html') — provided by the consumer. */
  offscreenUrl: string
  /** Justification reason for chrome.offscreen.createDocument. */
  offscreenReason: chrome.offscreen.Reason
  /** Hub mode; default 'offscreen-forward'. */
  hubMode?: 'echo' | 'offscreen-forward'
  /** Keyboard command name to bind to "activate on tab"; undefined = don't bind. */
  toggleCommand?: string
  /** Override the default activate-on-tab logic (e.g. to set transient UI state
   *  before sending the activate message). The default just ensures offscreen
   *  exists and posts `content/activate` to the tab. */
  onActivate?: (tabId: number) => Promise<void>
}

const DEFAULT_OFFSCREEN_JUSTIFICATION =
  'Host agent runtime and sandbox iframes for code-capable skills.'

export function installKernelBackground(opts: InstallKernelBackgroundOptions): void {
  const ensureOffscreen = async (): Promise<void> => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      documentUrls: [opts.offscreenUrl],
    })
    if (contexts.length > 0) return
    await chrome.offscreen.createDocument({
      url: opts.offscreenUrl,
      reasons: [opts.offscreenReason],
      justification: DEFAULT_OFFSCREEN_JUSTIFICATION,
    })
  }

  const defaultActivate = async (tabId: number): Promise<void> => {
    await ensureOffscreen()
    try {
      await chrome.tabs.sendMessage(tabId, { kind: 'content/activate' })
    } catch {
      // content script may not be loaded (e.g. chrome:// pages); silent ignore.
    }
  }
  const activate = opts.onActivate ?? defaultActivate

  // Lifecycle hooks — keep the offscreen document alive across SW restarts.
  chrome.runtime.onInstalled.addListener(async () => {
    await ensureOffscreen()
  })
  chrome.runtime.onStartup.addListener(async () => {
    await ensureOffscreen()
  })

  // Action click → activate on the clicked tab.
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id) await activate(tab.id)
  })

  // Optional keyboard command (e.g. 'toggle-chat').
  if (opts.toggleCommand) {
    const cmdName = opts.toggleCommand
    chrome.commands.onCommand.addListener(async (command, tab) => {
      if (command !== cmdName) return
      if (tab?.id) await activate(tab.id)
    })
  }

  // chrome.storage.session defaults to TRUSTED_CONTEXTS only (= no content
  // scripts). Widen it so content scripts can read transient UI state.
  // Idempotent — safe to call on every boot.
  chrome.storage.session
    .setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' as chrome.storage.AccessLevel,
    })
    .catch((e) => console.warn('[agent-kernel] widen session storage failed:', e))

  // Install hub + DOM-op router.
  const hub = installHub({ mode: opts.hubMode ?? 'offscreen-forward' })
  installDomOpRouter()

  // Forward SW-side runtime errors to all session ports for F12 visibility.
  ;(self as any).addEventListener?.('error', (e: any) => {
    hub.broadcastRuntimeError(e?.message ?? 'uncaught error', e?.error?.stack)
  })
  ;(self as any).addEventListener?.('unhandledrejection', (e: any) => {
    const reason = e?.reason
    const message =
      typeof reason === 'string' ? reason : reason?.message ?? 'unhandled rejection'
    hub.broadcastRuntimeError(message, reason?.stack)
  })

  console.log('[agent-kernel] background SW booted')
}
