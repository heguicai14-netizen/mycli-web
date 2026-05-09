// SkillDefinition + parseSkillMd. Both platform-neutral; no I/O.

export interface SkillDefinition {
  name: string
  description: string
  body: string
  /** Other files inside the skill folder, keyed by relative path. */
  files: Record<string, string>
  /** Unknown frontmatter keys, preserved for future use (tags, version, etc). */
  meta?: Record<string, string>
}

export interface ParsedSkillMd {
  name: string
  description: string
  body: string
  meta: Record<string, string>
}

export function parseSkillMd(raw: string, sourcePath: string): ParsedSkillMd {
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== '---') {
    throw new Error(
      `${sourcePath}: missing frontmatter — file must start with '---' on its own line`,
    )
  }
  // Find closing '---'.
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    throw new Error(`${sourcePath}: frontmatter not closed (no second '---')`)
  }

  const fm: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx < 0) {
      throw new Error(
        `${sourcePath}: malformed frontmatter line ${i + 1}: '${line}' (expected 'key: value')`,
      )
    }
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    fm[key] = value
  }

  if (!fm.name) {
    throw new Error(`${sourcePath}: frontmatter is missing required key 'name'`)
  }
  if (!fm.description) {
    throw new Error(
      `${sourcePath}: frontmatter is missing required key 'description'`,
    )
  }

  const known = new Set(['name', 'description'])
  const meta: Record<string, string> = {}
  for (const [k, v] of Object.entries(fm)) {
    if (!known.has(k)) meta[k] = v
  }

  // body is everything after the closing '---' line. Drop a single leading
  // blank line if present (the typical "---\n\n# body" pattern).
  let bodyLines = lines.slice(end + 1)
  if (bodyLines[0] === '') bodyLines = bodyLines.slice(1)
  const body = bodyLines.join('\n')

  return { name: fm.name, description: fm.description, body, meta }
}
