import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  patchSettings,
} from '@ext/storage/settings'

describe('settings', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear()
  })

  it('loadSettings returns defaults when empty', async () => {
    const s = await loadSettings()
    expect(s).toEqual(DEFAULT_SETTINGS)
  })

  it('saveSettings then loadSettings round-trips', async () => {
    const patched = { ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'gpt-4o' }
    await saveSettings(patched)
    const loaded = await loadSettings()
    expect(loaded.apiKey).toBe('sk-test')
    expect(loaded.model).toBe('gpt-4o')
  })

  it('patchSettings merges only provided keys', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'k1' })
    await patchSettings({ model: 'gpt-5' })
    const loaded = await loadSettings()
    expect(loaded.apiKey).toBe('k1')
    expect(loaded.model).toBe('gpt-5')
  })

  it('unknown stored fields are dropped on load (schema guard)', async () => {
    await chrome.storage.local.set({ mycliWebSettings: { ...DEFAULT_SETTINGS, bogus: 123 } as any })
    const loaded = await loadSettings()
    expect((loaded as any).bogus).toBeUndefined()
  })
})
