import type { ToolDefinition } from './types'
import { makeError, makeOk } from './Tool'
import type { SkillRegistry } from './SkillRegistry'

export interface ReadSkillFileInput {
  skill: string
  path: string
}

export interface ReadSkillFileOutput {
  content: string
}

export function createReadSkillFileTool({
  registry,
}: {
  registry: SkillRegistry
}): ToolDefinition<ReadSkillFileInput, ReadSkillFileOutput, any> {
  const def = {
    name: 'readSkillFile',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['skill', 'path'],
      additionalProperties: false,
    },
    async execute(input: ReadSkillFileInput) {
      const skill = registry.get(input.skill)
      if (!skill) {
        return makeError('unknown_skill', `No skill named '${input.skill}'.`)
      }
      const content = skill.files[input.path]
      if (content === undefined) {
        const have = Object.keys(skill.files).sort().join(', ') || '(none)'
        return makeError(
          'unknown_path',
          `Skill '${input.skill}' has no file '${input.path}'. Available: ${have}`,
        )
      }
      return makeOk({ content })
    },
  } as unknown as ToolDefinition<ReadSkillFileInput, ReadSkillFileOutput, any>

  Object.defineProperty(def, 'description', {
    enumerable: true,
    configurable: false,
    get() {
      const lines: string[] = []
      for (const skill of registry.list()) {
        for (const path of Object.keys(skill.files).sort()) {
          lines.push(`  ${skill.name}/${path}`)
        }
      }
      return [
        "Read a reference file from a skill's folder. Use after useSkill suggested a related file.",
        'The path is relative to the skill folder (e.g. \'references/style.md\').',
        '',
        'Files available:',
        ...(lines.length ? lines : ['  (none)']),
      ].join('\n')
    },
  })

  return def
}
