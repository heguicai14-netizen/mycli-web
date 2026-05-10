import type { FixtureCtx, Task } from '../core/types'

export function makeFixtureCtx(
  task: Task,
  loadSnapshot: (name: string) => string | undefined,
  loadCaption: (name: string) => string | undefined,
): FixtureCtx {
  return {
    task,
    state: new Map(),
    activeTabUrl: undefined,
    activeTabSnapshot: task.fixtures.snapshot,
    loadSnapshot,
    loadCaption,
  }
}

export function makeFsLoader(rootDir: string): (name: string) => string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = (globalThis as any).__node_fs__ ??
    // In Node / Bun test environment, require is available at runtime even
    // without TS node types. The cast avoids a compile-time error.
    // biome-ignore lint: dynamic require intentional for eval-only code
    (function () { try { return (eval('require'))('node:fs') } catch { return null } })()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = (globalThis as any).__node_path__ ??
    (function () { try { return (eval('require'))('node:path') } catch { return null } })()

  return (name) => {
    if (!fs || !path) return undefined
    const p = path.join(rootDir, name) as string
    try {
      return (fs.readFileSync as (p: string, enc: string) => string)(p, 'utf8')
    } catch {
      return undefined
    }
  }
}
