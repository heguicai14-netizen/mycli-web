import { describe, it, expect, vi } from 'vitest'
import { compactMessages } from '../../src/core/compactor'
import type { OpenAICompatibleClient, StreamEvent, ChatMessage } from 'agent-kernel'

function fakeClient(deltas: string[]): OpenAICompatibleClient {
  const streamChat = vi.fn(async function* (): AsyncIterable<StreamEvent> {
    for (const t of deltas) yield { kind: 'delta', text: t }
    yield { kind: 'done', stopReason: 'stop' }
  })
  return { streamChat } as unknown as OpenAICompatibleClient
}

const sample: ChatMessage[] = [
  { role: 'user', content: 'find the latest blog post on the home page' },
  { role: 'assistant', content: 'I will read the page first.' },
  { role: 'tool', content: '{"title":"Hello world","url":"/posts/hello"}' },
  { role: 'assistant', content: 'Latest post is "Hello world".' },
]

describe('compactMessages', () => {
  it('joins streamed deltas into the trimmed summary text', async () => {
    const client = fakeClient(['Goals\n', '- find latest post\n', '\nFacts\n', '- Hello world\n'])
    const out = await compactMessages({ messages: sample, client })
    expect(out).toBe('Goals\n- find latest post\n\nFacts\n- Hello world')
  })

  it('returns empty string when given no messages', async () => {
    const client = fakeClient(['ignored'])
    const out = await compactMessages({ messages: [], client })
    expect(out).toBe('')
    expect((client as any).streamChat).not.toHaveBeenCalled()
  })

  it('passes the abort signal through to the client', async () => {
    const captured: { signal?: AbortSignal } = {}
    const client = {
      streamChat: vi.fn(async function* (req: any): AsyncIterable<StreamEvent> {
        captured.signal = req.signal
        yield { kind: 'delta', text: 'x' }
        yield { kind: 'done', stopReason: 'stop' }
      }),
    } as unknown as OpenAICompatibleClient
    const ctrl = new AbortController()
    await compactMessages({ messages: sample, client, signal: ctrl.signal })
    expect(captured.signal).toBe(ctrl.signal)
  })

  it('propagates client errors so callers can degrade', async () => {
    const client = {
      streamChat: vi.fn(async function* (): AsyncIterable<StreamEvent> {
        throw new Error('rate_limit')
      }),
    } as unknown as OpenAICompatibleClient
    await expect(compactMessages({ messages: sample, client })).rejects.toThrow('rate_limit')
  })

  it('sends a system+user pair with the transcript embedded', async () => {
    let captured: any
    const client = {
      streamChat: vi.fn(async function* (req: any): AsyncIterable<StreamEvent> {
        captured = req
        yield { kind: 'delta', text: 'ok' }
        yield { kind: 'done', stopReason: 'stop' }
      }),
    } as unknown as OpenAICompatibleClient
    await compactMessages({ messages: sample, client })
    expect(captured.messages).toHaveLength(2)
    expect(captured.messages[0].role).toBe('system')
    expect(captured.messages[1].role).toBe('user')
    expect(captured.messages[1].content).toContain('find the latest blog post')
    expect(captured.messages[1].content).toContain('[tool]')
  })
})
