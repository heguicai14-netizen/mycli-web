import type { FakeToolFactory } from '../../core/types'
import { htmlToText } from '../htmlUtils'

export const makeFakeReadPage: FakeToolFactory = (ctx) => ({
  name: 'readPage',
  description: 'Read the active page content as plain text.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input: unknown, _ctx) {
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    if (!snap) return { ok: false, error: { code: 'no_snapshot', message: 'no snapshot bound', retryable: false } }
    const html = ctx.loadSnapshot(snap)
    if (!html) return { ok: false, error: { code: 'snapshot_not_found', message: `snapshot not found: ${snap}`, retryable: false } }
    return { ok: true, data: { url: ctx.activeTabUrl ?? `fixture://${snap}`, text: htmlToText(html) } }
  },
})
