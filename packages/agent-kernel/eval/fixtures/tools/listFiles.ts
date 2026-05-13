import type { FakeToolFactory } from '../../core/types'

export const makeFakeListFiles: FakeToolFactory = (ctx) => ({
  name: 'listFiles',
  description: 'List files in a directory (returns predefined tree from fixtures).',
  inputSchema: {
    type: 'object',
    properties: { dir: { type: 'string' } },
    additionalProperties: false,
  },
  async execute(input: any, _ctx) {
    const dir = input?.dir != null ? String(input.dir) : undefined
    const treeMap = ((ctx.task.fixtures as any).listFilesMap ?? {}) as Record<string, string[]>
    const files = treeMap[dir ?? '.'] ?? treeMap['*'] ?? []
    return { ok: true, data: files }
  },
})
