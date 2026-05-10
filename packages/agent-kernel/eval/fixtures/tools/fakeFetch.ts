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
      const n = (seen.get(url) ?? 0) + 1
      seen.set(url, n)
      if (entry !== undefined) {
        if (typeof entry === 'string') return { ok: true, data: { status: 200, body: entry } }
        if (entry.failOnce && n === 1) return { ok: false, error: { code: 'no_fetch_fixture', message: `http ${entry.status ?? 500}`, retryable: false } }
        return { ok: true, data: { status: entry.status ?? 200, body: entry.body } }
      }
      // Fallback: `fixture://NAME` URLs read the matching snapshot. Lets
      // multi-tab tasks (which expose URLs via listTabs) be inspected via
      // fetchGet without having to inline the page bodies into fetchMap.
      const FIXTURE_PREFIX = 'fixture://'
      if (url.startsWith(FIXTURE_PREFIX)) {
        const snapName = url.slice(FIXTURE_PREFIX.length)
        const html = ctx.loadSnapshot(snapName)
        if (html !== undefined) return { ok: true, data: { status: 200, body: html } }
      }
      return { ok: false, error: { code: 'no_fetch_fixture', message: `no fixture for ${url}`, retryable: false } }
    },
  }
}
