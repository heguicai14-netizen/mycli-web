/**
 * Minimum settings the kernel needs to drive the agent loop. Consumers may
 * carry additional fields in their own settings objects; the adapter is
 * responsible for narrowing to this shape on load.
 */
export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  systemPromptAddendum?: string
  toolMaxIterations?: number
}

export interface SettingsAdapter {
  /** Called once per turn to fetch current settings. */
  load(): Promise<Settings>
}
