import type { ApprovalContext } from '../core/approval'

/**
 * Resolve the active tab's origin + url for use as ApprovalContext.
 *
 * Returns `{}` if no active tab, no url, or chrome.tabs.query throws.
 * Returns `{ url }` only (no origin) when the URL is opaque
 * (about:blank, data:, file:) or malformed.
 *
 * IMPORTANT: in offscreen documents, call `polyfillChromeApiInOffscreen()`
 * before invoking this — otherwise `chrome.tabs` is undefined and this
 * silently returns `{}`. Service workers and popups don't need the polyfill.
 *
 * Browser-extension utility — any MV3 extension can use this verbatim,
 * or compose it with its own extension-specific context fields.
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
    const o = new URL(url).origin
    // URL.origin returns the literal string "null" for opaque origins
    // (about:blank, data:, file:). Filter that out so consumers using
    // ctx.origin for rule matching don't get a meaningless "null" value.
    if (o && o !== 'null') origin = o
  } catch {
    /* malformed input — fall through with only url */
  }
  return { url, ...(origin ? { origin } : {}) }
}
