import fs from 'node:fs'
import path from 'node:path'
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
  return (name) => {
    try {
      return fs.readFileSync(path.join(rootDir, name), 'utf8')
    } catch {
      return undefined
    }
  }
}
