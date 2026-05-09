import type { ToolDefinition } from './types'
import { makeError, makeOk } from './Tool'
import type { SkillRegistry } from './SkillRegistry'

export interface UseSkillInput {
  skill: string
}

export interface UseSkillOutput {
  content: string
}

export function createUseSkillTool({
  registry,
}: {
  registry: SkillRegistry
}): ToolDefinition<UseSkillInput, UseSkillOutput, any> {
  // Lazy description: re-rendered on every property read so skills registered
  // after tool creation still appear. ToolRegistry / OpenAI client read this
  // each turn, so the cost is negligible.
  const def = {
    name: 'useSkill',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Exact name of one of the available skills.',
        },
      },
      required: ['skill'],
      additionalProperties: false,
    },
    async execute(input: UseSkillInput): Promise<
      ReturnType<typeof makeOk<UseSkillOutput>> | ReturnType<typeof makeError>
    > {
      const skill = registry.get(input.skill)
      if (!skill) {
        return makeError(
          'unknown_skill',
          `No skill named '${input.skill}'. Call useSkill again with one of the listed names.`,
        )
      }
      let content = skill.body
      const fileNames = Object.keys(skill.files)
      if (fileNames.length > 0) {
        const lines = fileNames.sort().map((p) => `  - ${p}`).join('\n')
        content +=
          '\n\n---\nRelated files in this skill (call readSkillFile to load):\n' +
          lines +
          '\n'
      }
      return makeOk({ content })
    },
  } as unknown as ToolDefinition<UseSkillInput, UseSkillOutput, any>

  Object.defineProperty(def, 'description', {
    enumerable: true,
    configurable: false,
    get() {
      const skills = registry.list()
      const lines = skills.map((s) => ` • ${s.name} — ${s.description}`)
      return [
        "Loads a specialized skill's instructions when the user's request matches one.",
        'After calling, follow the returned instructions using your other tools.',
        '',
        'Available skills:',
        ...(lines.length ? lines : [' (none registered)']),
        '',
        'Call useSkill with the exact skill name. The result will be your instructions.',
      ].join('\n')
    },
  })

  return def
}
