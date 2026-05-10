// SW-side router for the DOM-op / chrome-api broadcast transport.
// Pair: see ./domOpClient.ts for the offscreen-side helpers that originate these requests.

export function installDomOpRouter(): void {
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
      // We use a separate broadcast (dom_op_result) for the response, never
      // sendResponse — so don't keep the message channel open. Returning true
      // here would surface a "channel closed before response received" warning
      // to the sender's Promise.
      return false
    }
    if (msg?.kind === 'chrome_api_request') {
      const { id, method, args } = msg
      handleChromeApi(method, args).then((result) =>
        chrome.runtime.sendMessage({ kind: 'chrome_api_result', id, result }),
      )
      // Same — response goes back via chrome_api_result broadcast, not sendResponse.
      return false
    }
    return false
  })
}

async function handleChromeApi(method: string, args: any[]): Promise<any> {
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
    if (method === 'storage.local.get') {
      const data = await chrome.storage.local.get(args[0])
      return { ok: true, data }
    }
    if (method === 'storage.local.set') {
      await chrome.storage.local.set(args[0])
      return { ok: true, data: undefined }
    }
    if (method === 'storage.local.remove') {
      await chrome.storage.local.remove(args[0])
      return { ok: true, data: undefined }
    }
    if (method === 'storage.session.get') {
      const data = await chrome.storage.session.get(args[0])
      return { ok: true, data }
    }
    if (method === 'storage.session.set') {
      await chrome.storage.session.set(args[0])
      return { ok: true, data: undefined }
    }
    if (method === 'storage.session.remove') {
      await chrome.storage.session.remove(args[0])
      return { ok: true, data: undefined }
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
