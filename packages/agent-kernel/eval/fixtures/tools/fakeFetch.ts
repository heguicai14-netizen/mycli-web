import type { FakeToolFactory } from '../../core/types'

export const makeFakeFetch: FakeToolFactory = (ctx) => {
  const seen = new Map<string, number>()
  return {
    name: 'fetchGet',
    description: 'HTTP GET a URL and return its body as text.',
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
      if (entry === undefined) return { ok: false, error: { code: 'no_fetch_fixture', message: `no fixture for ${url}`, retryable: false } }
      const n = (seen.get(url) ?? 0) + 1
      seen.set(url, n)
      if (typeof entry === 'string') return { ok: true, data: { status: 200, body: entry } }
      if (entry.failOnce && n === 1) return { ok: false, error: { code: 'no_fetch_fixture', message: `http ${entry.status ?? 500}`, retryable: false } }
      return { ok: true, data: { status: entry.status ?? 200, body: entry.body } }
    },
  }
}
