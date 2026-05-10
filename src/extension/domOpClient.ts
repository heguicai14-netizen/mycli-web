// Offscreen-side helpers for the DOM-op / chrome-api broadcast transport.
// Pair: see ./domOpRouter.ts for the SW-side handler that fulfils these requests.
//
// Protocol:
//   offscreen → broadcasts { kind: 'dom_op_request', id, op } via chrome.runtime.sendMessage
//   SW        → routes to op.tabId via chrome.tabs.sendMessage, then broadcasts
//               { kind: 'dom_op_result', id, result } back
//   offscreen → matches by id, resolves the awaiting promise

export async function sendDomOp(op: any, timeoutMs: number): Promise<any> {
  return new Promise<any>((resolve) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(
      () =>
        resolve({
          ok: false,
          error: { code: 'dom_op_timeout', message: 'no response', retryable: false },
        }),
      timeoutMs,
    )
    const listener = (msg: any) => {
      if (msg?.kind === 'dom_op_result' && msg.id === id) {
        chrome.runtime.onMessage.removeListener(listener)
        clearTimeout(timer)
        resolve(msg.result)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    // Fire-and-forget; the actual response comes back via the dom_op_result
    // broadcast that the listener above is watching. Swallow the Promise so
    // any "no response" warning from Chrome's message channel doesn't bubble
    // up as an unhandled rejection.
    void Promise.resolve(
      chrome.runtime.sendMessage({ kind: 'dom_op_request', id, op }),
    ).catch(() => {})
  })
}

export async function callChromeApi(method: string, args: unknown[]): Promise<any> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const listener = (msg: any) => {
      if (msg?.kind === 'chrome_api_result' && msg.id === id) {
        chrome.runtime.onMessage.removeListener(listener)
        resolve(msg.result)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    void Promise.resolve(
      chrome.runtime.sendMessage({ kind: 'chrome_api_request', id, method, args }),
    ).catch(() => {})
  })
}
