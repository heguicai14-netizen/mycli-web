import type { SettingsAdapter, Settings } from 'agent-kernel'
import { loadSettings } from './storage/settings'

/**
 * Narrows mycli-web's full settings object (which carries UI-only fields like
 * `fab`, `shortcut`, etc.) down to the kernel's Settings minimum.
 */
export const mycliSettingsAdapter: SettingsAdapter = {
  async load(): Promise<Settings> {
    const s = await loadSettings()
    return {
      apiKey: s.apiKey,
      baseUrl: s.baseUrl,
      model: s.model,
      systemPromptAddendum: s.systemPromptAddendum || undefined,
      toolMaxIterations: s.toolMaxIterations,
      autoCompact: s.autoCompact,
    }
  },
}
