import { loadSkillsFromViteGlob } from './viteGlobLoader'
import type { SkillRegistry } from '../SkillRegistry'

/**
 * Walk a directory on disk and build a SkillRegistry from the .md files
 * found inside `<root>/<skillName>/...`. Use this in CLI/Bun/Node contexts
 * where Vite's import.meta.glob isn't available.
 *
 * Uses dynamic imports of node:fs and node:path so the kernel module
 * doesn't pull node-only deps into browser bundles.
 */
export async function loadSkillsFromFs(rootDir: string): Promise<SkillRegistry> {
  // Cast to `any` so this module compiles without @types/node — kernel doesn't
  // pull node deps for browser consumers, and this loader is gated behind a
  // runtime-only dynamic import.
  const fs = (await import('node:fs' as any)) as any
  const path = (await import('node:path' as any)) as any
  const modules: Record<string, string> = {}
  if (!fs.existsSync(rootDir)) return loadSkillsFromViteGlob(modules)
  const walk = (dir: string, relPrefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }) as Array<{
      name: string
      isDirectory: () => boolean
      isFile: () => boolean
    }>) {
      const abs = path.join(dir, ent.name) as string
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.isFile() && ent.name.endsWith('.md')) {
        modules[`./skills/${rel}`] = fs.readFileSync(abs, 'utf-8') as string
      }
    }
  }
  walk(rootDir, '')
  return loadSkillsFromViteGlob(modules)
}
