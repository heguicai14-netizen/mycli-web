import type { SkillDefinition } from './Skill'

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>()

  register(skill: SkillDefinition): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`duplicate skill name: ${skill.name}`)
    }
    // Defensive copy of files so callers can mutate their input freely.
    this.skills.set(skill.name, { ...skill, files: { ...skill.files } })
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  }

  addFile(skillName: string, relPath: string, content: string): void {
    const skill = this.skills.get(skillName)
    if (!skill) throw new Error(`unknown skill: ${skillName}`)
    if (relPath in skill.files) {
      throw new Error(
        `duplicate file path '${relPath}' in skill '${skillName}'`,
      )
    }
    skill.files[relPath] = content
  }
}
