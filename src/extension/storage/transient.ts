import { z } from 'zod'

export const TransientUiState = z.object({
  activeConversationId: z.string().uuid().optional(),
  panelOpen: z.boolean().default(false),
  scrollTop: z.number().int().default(0),
  activatedTabs: z.record(z.string(), z.boolean()).default({}),
})
export type TransientUiState = z.infer<typeof TransientUiState>

const KEY = 'mycliWebUi'

export async function getTransientUi(): Promise<TransientUiState> {
  const r = await chrome.storage.session.get(KEY)
  const parsed = TransientUiState.safeParse(r[KEY])
  return parsed.success ? parsed.data : TransientUiState.parse({})
}

export async function setTransientUi(patch: Partial<TransientUiState>): Promise<TransientUiState> {
  const current = await getTransientUi()
  const next: TransientUiState = TransientUiState.parse({ ...current, ...patch })
  await chrome.storage.session.set({ [KEY]: next })
  return next
}
