import fs from 'node:fs'
import path from 'node:path'
import type { StreamEvent, ChatRequest, OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

export interface FixtureReadStore {
  get: (key: string) => unknown[] | undefined
}

function reqHash(req: ChatRequest): string {
  const stable = JSON.stringify({
    messages: req.messages,
    tools: req.tools?.map((t) => ({ name: t.function.name, params: t.function.parameters })),
  })
  let h = 0x811c9dc5
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function wrapForReplay(
  taskId: string,
  store: FixtureReadStore,
): Pick<OpenAICompatibleClient, 'streamChat'> {
  let callIndex = 0
  return {
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      const key = `${taskId}/${callIndex++}/${reqHash(req)}`
      const recorded = store.get(key)
      if (!recorded) {
        throw new Error(`replay: no fixture for key=${key} (request hash mismatch — re-record this task)`)
      }
      for (const ev of recorded as StreamEvent[]) yield ev
    },
  }
}

/** Directory-backed store for CLI usage. */
export function makeFsReplayStore(dir: string): FixtureReadStore {
  return {
    get(key: string): unknown[] | undefined {
      const safe = key.replace(/[/\\]/g, '__')
      const p = path.join(dir, `${safe}.json`)
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as unknown[]
      } catch {
        return undefined
      }
    },
  }
}

export function makeFsRecordStore(dir: string): { put: (k: string, v: unknown[]) => void } {
  fs.mkdirSync(dir, { recursive: true })
  return {
    put(key, value) {
      const safe = key.replace(/[/\\]/g, '__')
      fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(value, null, 2), 'utf8')
    },
  }
}
