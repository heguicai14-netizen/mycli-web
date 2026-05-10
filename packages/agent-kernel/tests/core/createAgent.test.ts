import { describe, it, expect, vi } from 'vitest'
import { createAgent, makeOk, makeError } from 'agent-kernel'
import type { OpenAICompatibleClient, StreamEvent } from 'agent-kernel'
import type { ToolDefinition } from 'agent-kernel'

function fakeClient(scripts: StreamEvent[][]): OpenAICompatibleClient {
  let turn = 0
  return {
    async *streamChat() {
      const chunks = scripts[turn++] ?? []
      for (const c of chunks) yield c
    },
  } as any
}

describe('createAgent', () => {
  it('streams message/streamChunk events for assistant deltas and ends with done', async () => {
    const agent = createAgent({
      llmClient: fakeClient([[
        { kind: 'delta', text: 'Hello' },
        { kind: 'delta', text: ' world' },
        { kind: 'done', stopReason: 'stop' },
      ]]),
      tools: [],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('hi')) events.push(ev)

    const chunks = events.filter((e) => e.kind === 'message/streamChunk').map((e) => e.delta)
    expect(chunks.join('')).toBe('Hello world')

    const last = events[events.length - 1]
    expect(last.kind).toBe('done')
    expect(last.stopReason).toBe('end_turn')
    expect(last.assistantText).toBe('Hello world')
  })

  it('seeds prior history via send opts', async () => {
    const agent = createAgent({
      llmClient: fakeClient([[
        { kind: 'delta', text: 'ack' },
        { kind: 'done', stopReason: 'stop' },
      ]]),
      tools: [],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('q2', {
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
    })) events.push(ev)

    const last = events[events.length - 1]
    expect(last.kind).toBe('done')
    expect(last.assistantText).toBe('ack')
  })

  it('cancel() aborts the in-flight LLM call', async () => {
    let aborted = false
    const agent = createAgent({
      llmClient: {
        async *streamChat({ signal }: any) {
          signal?.addEventListener('abort', () => { aborted = true })
          await new Promise((r) => setTimeout(r, 30))
          yield { kind: 'done', stopReason: 'stop' } as StreamEvent
        },
      } as any,
      tools: [],
      toolContext: {},
    })

    const it = agent.send('hi')[Symbol.asyncIterator]()
    setTimeout(() => agent.cancel(), 5)
    while (!(await it.next()).done) {}
    expect(aborted).toBe(true)
  })

  it('routes tool calls through the registered tool and forwards result', async () => {
    const echoTool: ToolDefinition<{ value: string }, { echoed: string }> = {
      name: 'echo',
      description: 'echo input',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      async execute(input) {
        return makeOk({ echoed: input.value })
      },
    }

    const agent = createAgent({
      llmClient: fakeClient([
        // turn 1: model emits tool_calls=echo
        [
          {
            kind: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'echo', input: { value: 'hi' } }],
          },
        ],
        // turn 2: model wraps up after seeing tool result
        [
          { kind: 'delta', text: 'You said: hi' },
          { kind: 'done', stopReason: 'stop' },
        ],
      ]),
      tools: [echoTool],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('say hi')) events.push(ev)

    const start = events.find((e) => e.kind === 'tool/start')
    expect(start.toolCall).toMatchObject({ id: 'call_1', tool: 'echo' })

    const end = events.find((e) => e.kind === 'tool/end')
    expect(end.result.ok).toBe(true)
    expect(JSON.parse(end.result.content)).toEqual({ echoed: 'hi' })

    const last = events[events.length - 1]
    expect(last.kind).toBe('done')
    expect(last.assistantText).toBe('You said: hi')
  })

  it('surfaces tool errors via tool/end with ok:false (engine never throws)', async () => {
    const failingTool: ToolDefinition<unknown, unknown> = {
      name: 'fail',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return makeError('boom', 'simulated failure', false)
      },
    }

    const agent = createAgent({
      llmClient: fakeClient([
        [
          {
            kind: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'c1', name: 'fail', input: {} }],
          },
        ],
        [{ kind: 'delta', text: 'noted' }, { kind: 'done', stopReason: 'stop' }],
      ]),
      tools: [failingTool],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('go')) events.push(ev)

    const end = events.find((e) => e.kind === 'tool/end')
    expect(end.result.ok).toBe(false)
    expect(end.result.content).toContain('boom')
  })

  it('returns ok:false when LLM calls an unknown tool', async () => {
    const agent = createAgent({
      llmClient: fakeClient([
        [
          {
            kind: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'c1', name: 'nonexistent', input: {} }],
          },
        ],
        [{ kind: 'done', stopReason: 'stop' }],
      ]),
      tools: [],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('ask')) events.push(ev)

    const end = events.find((e) => e.kind === 'tool/end')
    expect(end).toBeDefined()
    expect(end.result.ok).toBe(false)
    expect(end.result.content).toContain('nonexistent')
  })

  it('throws synchronously when neither llm nor llmClient is provided', () => {
    expect(() =>
      createAgent({
        tools: [],
        toolContext: {},
      } as any),
    ).toThrow(/llm|llmClient/i)
  })

  it('passes ExtraCtx fields into tool.execute via merged ctx', async () => {
    type Ctx = { tabId: number; rpc: { ping: ReturnType<typeof vi.fn> } }
    const seenCtx: any[] = []
    const sniffer: ToolDefinition<unknown, unknown, Ctx> = {
      name: 'sniffer',
      description: 'records ctx',
      inputSchema: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        seenCtx.push(ctx)
        return makeOk({ ok: true })
      },
    }

    const agent = createAgent({
      llmClient: fakeClient([
        [
          {
            kind: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'c1', name: 'sniffer', input: {} }],
          },
        ],
        [{ kind: 'done', stopReason: 'stop' }],
      ]),
      tools: [sniffer],
      toolContext: { tabId: 99, rpc: { ping: vi.fn() } },
    })

    for await (const _ of agent.send('go')) {}
    expect(seenCtx).toHaveLength(1)
    expect(seenCtx[0].tabId).toBe(99)
    expect(typeof seenCtx[0].rpc.ping).toBe('function')
  })

  it('reuses session after cancel: send() resets the AbortController', async () => {
    let firstAborted = false
    let secondCallCount = 0
    const agent = createAgent({
      llmClient: {
        async *streamChat({ signal }: any) {
          if (secondCallCount === 0) {
            secondCallCount++
            signal?.addEventListener('abort', () => {
              firstAborted = true
            })
            await new Promise((r) => setTimeout(r, 30))
            yield { kind: 'done', stopReason: 'stop' } as StreamEvent
          } else {
            yield { kind: 'delta', text: 'second' } as StreamEvent
            yield { kind: 'done', stopReason: 'stop' } as StreamEvent
          }
        },
      } as any,
      tools: [],
      toolContext: {},
    })

    // first send: cancel mid-flight
    const iter = agent.send('first')[Symbol.asyncIterator]()
    setTimeout(() => agent.cancel(), 5)
    while (!(await iter.next()).done) {}
    expect(firstAborted).toBe(true)

    // second send: should run normally because send() resets the controller
    const events: any[] = []
    for await (const ev of agent.send('second')) events.push(ev)
    const last = events[events.length - 1]
    expect(last.kind).toBe('done')
    expect(last.assistantText).toBe('second')
  })
})
