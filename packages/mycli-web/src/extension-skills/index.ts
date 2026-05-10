import { createUseSkillTool, createReadSkillFileTool } from 'agent-kernel'
import { buildRegistryFromModules } from './loader'

// Vite-compile-time glob of every markdown file under skills/. Returns a
// path-keyed map of raw strings. Eager: false would require .then() at the
// call site — eager is fine because the bundle is small.
const modules = import.meta.glob('./skills/**/*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

export const skillRegistry = buildRegistryFromModules(modules)
export const useSkillTool = createUseSkillTool({ registry: skillRegistry })
export const readSkillFileTool = createReadSkillFileTool({
  registry: skillRegistry,
})
