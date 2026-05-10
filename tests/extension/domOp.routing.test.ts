import { describe, it, expect, beforeEach } from 'vitest'
import { installMultiContextChrome, type MultiContextBus } from '../mocks/chromeMultiContext'
import { sendDomOp, callChromeApi } from '@ext/domOpClient'
import { installDomOpRouter } from '@ext/domOpRouter'
import { installDomHandlers } from '@ext-tools/content/domHandlers'

// Wires the three real production pieces of the dom_op broadcast transport
// (offscreen client → SW router → content handler) through a multi-context
// chrome.* mock and verifies round-trip behavior end-to-end.
//
// This is the only test that exercises the broadcast path; per-tool tests
// (e.g. readPage.test.ts) mock ctx.rpc.domOp directly.

describe('dom_op routing (offscreen ↔ SW ↔ content)', () => {
  let bus: MultiContextBus

  beforeEach(() => {
    bus = installMultiContextChrome()
    bus.registerContext('offscreen')
    bus.registerContext('sw')
    bus.runIn('sw', () => installDomOpRouter())
  })

  it('round-trips dom/readPage through SW to a content tab', async () => {
    document.body.innerHTML = '<p>hello world</p>'
    bus.runIn('tab:1', () => installDomHandlers())

    // 'html-simplified' uses outerHTML (works under jsdom); 'text' depends on
    // innerText which jsdom does not implement.
    const result = await bus.runIn('offscreen', () =>
      sendDomOp({ kind: 'dom/readPage', tabId: 1, mode: 'html-simplified' }, 1000),
    )

    expect(result.ok).toBe(true)
    expect(result.data.text).toContain('hello world')
  })

  it('round-trips dom/querySelector through SW to a content tab', async () => {
    document.body.innerHTML = '<button id="x">click</button>'
    bus.runIn('tab:1', () => installDomHandlers())

    const result = await bus.runIn('offscreen', () =>
      sendDomOp({ kind: 'dom/querySelector', tabId: 1, selector: '#x', all: false }, 1000),
    )

    expect(result.ok).toBe(true)
    expect(result.data.matches[0].text).toBe('click')
  })

  it('returns no_tab when op has no tabId', async () => {
    bus.runIn('tab:1', () => installDomHandlers())

    const result = await bus.runIn('offscreen', () =>
      sendDomOp({ kind: 'dom/readPage', mode: 'text' }, 1000),
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('no_tab')
  })

  it('returns tab_unreachable when target tab has no content script', async () => {
    // Note: deliberately do NOT register tab:99 — simulates a chrome:// page
    // or a tab that was open before the extension was installed (Chrome does
    // not auto-inject content scripts into pre-existing tabs).
    const result = await bus.runIn('offscreen', () =>
      sendDomOp({ kind: 'dom/readPage', tabId: 99, mode: 'text' }, 1000),
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('tab_unreachable')
  })

  it('times out (dom_op_timeout) when SW router is not installed', async () => {
    // Simulate the SW being asleep / never responding. We remove the SW context's
    // onMessage listener by re-creating the bus without installing the router.
    const isolatedBus = installMultiContextChrome()
    isolatedBus.registerContext('offscreen')
    isolatedBus.registerContext('tab:1')
    isolatedBus.runIn('tab:1', () => installDomHandlers())

    const result = await isolatedBus.runIn('offscreen', () =>
      sendDomOp({ kind: 'dom/readPage', tabId: 1, mode: 'text' }, 50),
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('dom_op_timeout')
    expect(result.error.message).toBe('no response')
  })

  it('returns unknown_op when content handler does not recognize the op kind', async () => {
    bus.runIn('tab:1', () => installDomHandlers())

    const result = await bus.runIn('offscreen', () =>
      sendDomOp({ kind: 'dom/madeUpOp', tabId: 1 }, 1000),
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('unknown_op')
  })
})

describe('chrome_api routing (offscreen ↔ SW)', () => {
  let bus: MultiContextBus

  beforeEach(() => {
    bus = installMultiContextChrome()
    bus.registerContext('offscreen')
    bus.registerContext('sw')
    bus.runIn('sw', () => installDomOpRouter())
  })

  it('returns unknown_method for an unsupported method', async () => {
    const result = await bus.runIn('offscreen', () =>
      callChromeApi('does.not.exist', []),
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('unknown_method')
  })
})
