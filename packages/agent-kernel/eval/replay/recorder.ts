import type { OpenAICompatibleClient, StreamEvent, ChatRequest } from '../../src/core/OpenAICompatibleClient'

export interface FixtureStore {
  put: (key: string, value: unknown[]) => void
}

function reqHash(req: ChatRequest): string {
  // Stable hash: messages + tools shape, ignore signal
  const stable = JSON.stringify({
    messages: req.messages,
    tools: req.tools?.map((t) => ({ name: t.function.name, params: t.function.parameters })),
  })
  // simple FNV-1a 32-bit
  let h = 0x811c9dc5
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function wrapForRecord(
  inner: Pick<OpenAICompatibleClient, 'streamChat'>,
  taskId: string,
  store: FixtureStore,
): Pick<OpenAICompatibleClient, 'streamChat'> {
  let callIndex = 0
  return {
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      const key = `${taskId}/${callIndex++}/${reqHash(req)}`
      const buf: StreamEvent[] = []
      for await (const ev of inner.streamChat(req)) {
        buf.push(ev)
        yield ev
      }
      store.put(key, buf)
    },
  }
}
