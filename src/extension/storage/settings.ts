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
