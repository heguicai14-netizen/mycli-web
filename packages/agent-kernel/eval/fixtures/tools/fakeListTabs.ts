import type { FakeToolFactory } from '../../core/types'
import { parseDom } from '../htmlUtils'

export const makeFakeListTabs: FakeToolFactory = (ctx) => ({
  name: 'listTabs',
  description: 'List the URLs and titles of currently open tabs.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input: unknown, _ctx) {
    const tabs = ctx.task.fixtures.tabs ?? []
    const out = tabs.map((name) => {
      const html = ctx.loadSnapshot(name)
      const title = html ? (parseDom(html).querySelector('title')?.textContent ?? name) : name
      return { url: `fixture://${name}`, title }
    })
    return { ok: true, data: { tabs: out } }
  },
})
