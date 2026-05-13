import type { FakeToolFactory } from '../../core/types'

export const makeFakeGrepFile: FakeToolFactory = (ctx) => ({
  name: 'grepFile',
  description: 'Search for files containing a pattern (returns matching paths).',
  inputSchema: {
    type: 'object',
    properties: { pattern: { type: 'string' }, dir: { type: 'string' } },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input: any, _ctx) {
    const pattern = String(input?.pattern ?? '')
    const grepMap = ((ctx.task.fixtures as any).grepMap ?? {}) as Record<string, string[]>
    const matches = grepMap[pattern] ?? []
    return { ok: true, data: matches }
  },
})
