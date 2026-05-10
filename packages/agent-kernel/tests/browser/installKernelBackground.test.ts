import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installKernelBackground } from 'agent-kernel'

beforeEach(() => {
  // Reset chrome mock per test — kernel installs listeners as a side effect,
  // so each case wants a fresh chrome.* surface.
  ;(globalThis as any).chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getContexts: vi.fn(async () => []),
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      lastError: undefined,
    },
    action: { onClicked: { addListener: vi.fn() } },
    commands: { onCommand: { addListener: vi.fn() } },
    storage: {
      session: { setAccessLevel: vi.fn(async () => {}) },
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
      Reason: { IFRAME_SCRIPTING: 'IFRAME_SCRIPTING' },
    },
    tabs: { sendMessage: vi.fn() },
  }
})

describe('installKernelBackground', () => {
  it('registers the hub onConnect listener', () => {
    installKernelBackground({
      offscreenUrl: 'chrome-extension://abc/html/offscreen.html',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect((chrome.runtime.onConnect.addListener as any)).toHaveBeenCalled()
  })

  it('registers the dom op router on chrome.runtime.onMessage', () => {
    installKernelBackground({
      offscreenUrl: 'chrome-extension://abc/html/offscreen.html',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect((chrome.runtime.onMessage.addListener as any)).toHaveBeenCalled()
  })

  it('registers action onClicked when no custom onActivate is given', () => {
    installKernelBackground({
      offscreenUrl: 'x',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect((chrome.action!.onClicked.addListener as any)).toHaveBeenCalled()
  })

  it('registers commands.onCommand when toggleCommand is provided', () => {
    installKernelBackground({
      offscreenUrl: 'x',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
      toggleCommand: 'toggle-chat',
    })
    expect((chrome.commands!.onCommand.addListener as any)).toHaveBeenCalled()
  })

  it('does not register commands.onCommand when toggleCommand is undefined', () => {
    installKernelBackground({
      offscreenUrl: 'x',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect((chrome.commands!.onCommand.addListener as any)).not.toHaveBeenCalled()
  })
})
