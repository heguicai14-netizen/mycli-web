import type { ApprovalContext } from '../core/approval'

/**
 * Resolve the active tab's origin + url for use as ApprovalContext.
 *
 * Returns {} if no active tab or no url. Browser-extension utility — any
 * MV3 extension can use this verbatim (SW, popup, or offscreen after
 * polyfillChromeApiInOffscreen()), or compose it with its own
 * extension-specific context fields.
 */
export async function buildActiveTabApprovalContext(): Promise<ApprovalContext> {
  let tabs: Array<{ url?: string }> | undefined
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch {
    return {}
  }
  const url = tabs?.[0]?.url
  if (!url) return {}
  let origin: string | undefined
  try {
    origin = new URL(url).origin
  } catch {
    /* opaque/about: tabs — fall through with only url */
  }
  return { url, ...(origin ? { origin } : {}) }
}
