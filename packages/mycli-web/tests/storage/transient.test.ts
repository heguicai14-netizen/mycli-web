import { describe, it, expect, beforeEach } from 'vitest'
import { getTransientUi, setTransientUi } from '@ext/storage/transient'

describe('transient ui state', () => {
  beforeEach(async () => {
    await chrome.storage.session.clear()
  })

  it('returns defaults when empty', async () => {
    const s = await getTransientUi()
    expect(s.panelOpen).toBe(false)
    expect(s.scrollTop).toBe(0)
  })

  it('patch then read round-trips', async () => {
    await setTransientUi({ panelOpen: true })
    expect((await getTransientUi()).panelOpen).toBe(true)
  })
})
