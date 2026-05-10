import type { FakeToolFactory } from '../../core/types'

export const makeFakeUseSkill: FakeToolFactory = (ctx) => ({
  name: 'useSkill',
  description: 'Load a skill by name; returns the skill body the agent should follow.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  async execute(input: any, _ctx) {
    const name = String(input?.name ?? '')
    const skills = ctx.task.fixtures.skills ?? {}
    const body = skills[name]
    if (body === undefined) return { ok: false, error: { code: 'no_such_skill', message: `no such skill: ${name}`, retryable: false } }
    return { ok: true, data: { name, body } }
  },
})
