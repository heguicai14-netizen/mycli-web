/**
 * Minimum settings the kernel needs to drive the agent loop. Consumers may
 * carry additional fields in their own settings objects; the adapter is
 * responsible for narrowing to this shape on load.
 */
/**
 * Auto-compaction policy. The agent estimates the token footprint of the
 * conversation history before each LLM call and, if it exceeds the threshold,
 * summarizes older messages via a one-shot LLM call. Threshold is computed as
 * `modelContextWindow * thresholdPercent / 100`. Provider responses don't
 * include the model's max context window, so it must be configured here.
 */
export interface AutoCompactSettings {
  enabled: boolean
  modelContextWindow: number
  thresholdPercent: number
  keepRecentMessages: number
}

export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  systemPromptAddendum?: string
  toolMaxIterations?: number
  autoCompact?: AutoCompactSettings
}

export interface SettingsAdapter {
  /** Called once per turn to fetch current settings. */
  load(): Promise<Settings>
}
