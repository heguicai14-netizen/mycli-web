// Plan A: offscreen document placeholder. Plan B hosts QueryEngine + tool dispatch here.

console.log('[mycli-web] offscreen document booted at', new Date().toISOString())

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'offscreen/ping') {
    sendResponse({ kind: 'offscreen/pong', ts: Date.now() })
    return true
  }
  return false
})
