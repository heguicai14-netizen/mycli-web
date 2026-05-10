import type { FakeToolFactory } from '../../core/types'

const RE = /<!--\s*SELECTION\s*-->([\s\S]*?)<!--\s*\/SELECTION\s*-->/

export const makeFakeReadSelection: FakeToolFactory = (ctx) => ({
  name: 'readSelection',
  description: 'Read user-selected text on the active page.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input: unknown, _ctx) {
    const snap = ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot
    const html = snap ? ctx.loadSnapshot(snap) : undefined
    if (!html) return { ok: false, error: { code: 'no_snapshot', message: 'no snapshot bound', retryable: false } }
    const m = RE.exec(html)
    if (!m) return { ok: false, error: { code: 'no_selection', message: 'no <!-- SELECTION --> in snapshot', retryable: false } }
    return { ok: true, data: { text: m[1].trim() } }
  },
})
