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
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  return (name) => {
    const p = path.join(rootDir, name)
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return undefined
    }
  }
}
