import type { FakeToolFactory } from '../../core/types'

export const makeFakeMarkRead: FakeToolFactory = (ctx) => ({
  name: 'markRead',
  description: 'Mark a URL as read so the agent can track its reading list.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false,
  },
  async execute(input: any, _ctx) {
    const url = String(input?.url ?? '')
    const prev = (ctx.state.get('readUrls') as string[] | undefined) ?? []
    ctx.state.set('readUrls', [...prev, url])
    return { ok: true, data: 'marked' }
  },
})
