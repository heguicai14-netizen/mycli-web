import type { FakeToolFactory } from '../../core/types'

export const makeFakeEditFile: FakeToolFactory = (ctx) => ({
  name: 'editFile',
  description: 'Edit a file by writing new content (stateful — records the edit).',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, newContent: { type: 'string' } },
    required: ['path', 'newContent'],
    additionalProperties: false,
  },
  async execute(input: any, _ctx) {
    const path = String(input?.path ?? '')
    const newContent = String(input?.newContent ?? '')
    const prev =
      (ctx.state.get('edits') as Array<{ path: string; newContent: string }> | undefined) ?? []
    ctx.state.set('edits', [...prev, { path, newContent }])
    return { ok: true, data: 'edited' }
  },
})
