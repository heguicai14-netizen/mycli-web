import type { FakeToolFactory } from '../../core/types'

export const makeFakeSlowFetch: FakeToolFactory = (ctx) => ({
  name: 'slowFetch',
  description: 'Fetch a URL with simulated network delay. Use for parallel-investigation scenarios.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false,
  },
  async execute(input: any, _ctx) {
    const url = String(input?.url ?? '')
    const map = ctx.task.fixtures.fetchMap ?? {}
    const entry = map[url]
    const delayMs = (ctx.task.fixtures as any).slowFetchDelayMs ?? 500
    await new Promise((r) => setTimeout(r, delayMs))
    if (entry === undefined) {
      return { ok: false, error: { code: 'not_found', message: url, retryable: false } }
    }
    const body = typeof entry === 'string' ? entry : entry.body
    const status = typeof entry === 'string' ? 200 : (entry.status ?? 200)
    if (status >= 400) {
      return { ok: false, error: { code: 'http_error', message: `HTTP ${status}`, retryable: false } }
    }
    return { ok: true, data: body }
  },
})
