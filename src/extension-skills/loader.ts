import { SkillRegistry, parseSkillMd } from '@core'

/**
 * Build a SkillRegistry from a flat path → raw-content map. Path keys must
 * look like './skills/<skillName>/SKILL.md' or
 * './skills/<skillName>/<relPath>'. Anything outside './skills/' is ignored.
 *
 * Pulled out of index.ts so it can be unit-tested with a synthetic dict
 * (no real Vite glob needed).
 */
export function buildRegistryFromModules(
  modules: Record<string, string>,
): SkillRegistry {
  // Group entries by skill folder name.
  // Path layout: './skills/<folder>/<rest>' (rest may include sub-dirs).
  const PREFIX = './skills/'
  const byFolder = new Map<string, Record<string, string>>()
  for (const [path, content] of Object.entries(modules)) {
    if (!path.startsWith(PREFIX)) continue
    const tail = path.slice(PREFIX.length) // 'foo/SKILL.md' or 'foo/references/x.md'
    const slash = tail.indexOf('/')
    if (slash < 0) continue // top-level file like ./skills/loose.md — ignore
    const folder = tail.slice(0, slash)
    const rel = tail.slice(slash + 1)
    if (!byFolder.has(folder)) byFolder.set(folder, {})
    byFolder.get(folder)![rel] = content
  }

  const registry = new SkillRegistry()
  // Stable order: alphabetical by folder name.
  const sorted = Array.from(byFolder.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  for (const [folder, files] of sorted) {
    // Skill must have SKILL.md at its folder root (not nested deeper).
    const entryRaw = files['SKILL.md']
    if (!entryRaw) {
      throw new Error(
        `skill folder '${folder}' is missing SKILL.md at its root (found: ${Object.keys(files).join(', ') || '(none)'})`,
      )
    }
    const parsed = parseSkillMd(entryRaw, `${folder}/SKILL.md`)
    if (parsed.name !== folder) {
      throw new Error(
        `skill folder '${folder}' SKILL.md frontmatter name='${parsed.name}' must match folder name`,
      )
    }
    registry.register({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      files: {},
      meta: parsed.meta,
    })
    for (const [relPath, content] of Object.entries(files)) {
      if (relPath === 'SKILL.md') continue
      registry.addFile(folder, relPath, content)
    }
  }
  return registry
}
