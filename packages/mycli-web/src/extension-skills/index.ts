import {
  createUseSkillTool,
  createReadSkillFileTool,
  loadSkillsFromViteGlob,
} from 'agent-kernel'

// Vite-compile-time glob of every markdown file under skills/. Returns a
// path-keyed map of raw strings. Eager: false would require .then() at the
// call site — eager is fine because the bundle is small.
const modules = import.meta.glob('./skills/**/*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

export const skillRegistry = loadSkillsFromViteGlob(modules)
export const useSkillTool = createUseSkillTool({ registry: skillRegistry })
export const readSkillFileTool = createReadSkillFileTool({
  registry: skillRegistry,
})
