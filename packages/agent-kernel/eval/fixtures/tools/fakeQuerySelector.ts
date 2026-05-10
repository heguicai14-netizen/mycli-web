import type { FakeToolFactory } from '../../core/types'
import { parseDom } from '../htmlUtils'

export const makeFakeQuerySelector: FakeToolFactory = (ctx) => ({
  name: 'querySelector',
  description: 'Return textContent of the first element matching a CSS selector.',
  inputSchema: {
    type: 'object',
    properties: { selector: { type: 'string' } },
    required: ['selector'],
    additionalProperties: false,
  },
  async execute(input: any, _ctx) {
    const selector = String(input?.selector ?? '')
    if (!selector) return { ok: false, error: { code: 'bad_args', message: 'selector required', retryable: false } }
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    const html = snap ? ctx.loadSnapshot(snap) : undefined
    if (!html) return { ok: false, error: { code: 'no_snapshot', message: 'no snapshot bound', retryable: false } }
    const doc = parseDom(html)
    const el = doc.querySelector(selector)
    if (!el) return { ok: false, error: { code: 'no_match', message: `no match: ${selector}`, retryable: false } }
    return { ok: true, data: { text: el.textContent?.trim() ?? '' } }
  },
})
