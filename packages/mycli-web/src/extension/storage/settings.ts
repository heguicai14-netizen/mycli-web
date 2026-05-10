import { z } from 'zod'

export const Settings = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().url().or(z.literal('')).default('https://api.openai.com/v1'),
  model: z.string().default('gpt-4o-mini'),
  systemPromptAddendum: z.string().default(''),
  subAgentMaxDepth: z.number().int().min(0).max(10).default(3),
  toolMaxIterations: z.number().int().min(1).max(500).default(50),
  fab: z
    .object({
      enabled: z.boolean().default(true),
      position: z.enum(['bottom-right', 'bottom-left']).default('bottom-right'),
    })
    .default({ enabled: true, position: 'bottom-right' }),
  shortcut: z.string().default('Ctrl+Shift+K'),
  skillHostStrictMode: z.boolean().default(true),
  injectScriptEnabled: z.boolean().default(false),
  auditLogRetentionDays: z.number().int().min(1).max(365).default(30),
  bundledSkillsEnabled: z.array(z.string()).default([]),
  contextAutoInject: z.enum(['none', 'url-title', 'url-title-and-selection']).default('url-title'),
  autoCompact: z
    .object({
      enabled: z.boolean().default(true),
      // Default 128000 covers gpt-4o / gpt-4o-mini. Users on smaller-context
      // models (e.g. gpt-3.5 = 16k) should lower this in Options.
      modelContextWindow: z.number().int().min(2000).max(2_000_000).default(128_000),
      thresholdPercent: z.number().int().min(10).max(95).default(75),
      keepRecentMessages: z.number().int().min(2).max(50).default(6),
    })
    .default({
      enabled: true,
      modelContextWindow: 128_000,
      thresholdPercent: 75,
      keepRecentMessages: 6,
    }),
})
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = Settings.parse({})

const KEY = 'mycliWebSettings'

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(KEY)
  const raw = r[KEY]
  if (raw === undefined) return DEFAULT_SETTINGS
  const parsed = Settings.safeParse(raw)
  if (!parsed.success) return DEFAULT_SETTINGS
  return parsed.data
}

export async function saveSettings(s: Settings): Promise<void> {
  const parsed = Settings.parse(s)
  await chrome.storage.local.set({ [KEY]: parsed })
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next: Settings = Settings.parse({ ...current, ...patch })
  await chrome.storage.local.set({ [KEY]: next })
  return next
}
