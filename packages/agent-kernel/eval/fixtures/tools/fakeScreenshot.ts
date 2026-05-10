import type { FakeToolFactory } from '../../core/types'

export const makeFakeScreenshot: FakeToolFactory = (ctx) => ({
  name: 'screenshot',
  description: 'Capture a screenshot of the active tab and return a caption of its visible content.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input: unknown, _ctx) {
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    if (!snap) return { ok: false, error: { code: 'no_snapshot', message: 'no snapshot bound', retryable: false } }
    const captionFile = snap.replace(/\.html$/, '.caption.txt')
    const caption = ctx.loadCaption(captionFile) ?? ctx.loadCaption(snap) ?? `Screenshot of ${snap}`
    return { ok: true, data: { caption } }
  },
})
