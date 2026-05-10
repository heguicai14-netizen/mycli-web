import { describe, it, expect, vi } from 'vitest'
import { createAgentService } from '@ext/agentService'
import type { AgentEvent as CoreAgentEvent, ToolDefinition } from 'agent-kernel'

// Minimal fake AgentSession that yields a scripted stream of agent-core events.
function makeFakeAgent(events: CoreAgentEvent[]) {
  const cancelled = { value: false }
  const session = {
    send: () => ({
      async *[Symbol.asyncIterator]() {
        for (const ev of events) {
          if (cancelled.value) return
          yield ev
        }
      },
    }),
    cancel: () => {
      cancelled.value = true
    },
  }
  return { session, cancelled }
}

function defaultSettings(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://test.local/v1',
    model: 'gpt-test',
    systemPromptAddendum: '',
    subAgentMaxDepth: 3,
    toolMaxIterations: 50,
    fab: { enabled: true, position: 'bottom-right' as const },
    shortcut: 'Ctrl+Shift+K',
    skillHostStrictMode: true,
    injectScriptEnabled: false,
    auditLogRetentionDays: 30,
    bundledSkillsEnabled: [],
    contextAutoInject: 'url-title' as const,
    ...overrides,
  } as any
}

function makeDeps(opts: {
  settings?: ReturnType<typeof defaultSettings>
  agentEvents?: CoreAgentEvent[]
  history?: Array<{ id: string; role: string; content: unknown; compacted?: boolean }>
  tools?: ToolDefinition<any, any, any>[]
  capturedAgentOpts?: { current: any }
}) {
  const events: any[] = []
  const idbCalls: string[] = []
  const fake = makeFakeAgent(
    opts.agentEvents ?? [
      { kind: 'message/streamChunk', delta: 'hello' },
      { kind: 'done', stopReason: 'end_turn', assistantText: 'hello' },
    ],
  )

  const deps = {
    loadSettings: async () => opts.settings ?? defaultSettings(),
    emit: (ev: any) => {
      events.push(ev)
    },
    appendMessage: vi.fn(async (msg: any) => {
      idbCalls.push(`append:${msg.role}`)
      return { id: `msg-${idbCalls.length}`, createdAt: 1000 + idbCalls.length }
    }),
    listMessagesByConversation: vi.fn(async () => {
      idbCalls.push('list')
      return opts.history ?? []
    }),
    updateMessage: vi.fn(async () => {
      idbCalls.push('update')
    }),
    activeConversationId: vi.fn(async () => 'conv-1'),
    buildToolContext: vi.fn(async () => ({
      rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
      tabId: 99,
      conversationId: 'conv-1',
    })),
    tools: opts.tools,
    createAgent: vi.fn((agentOpts: any) => {
      if (opts.capturedAgentOpts) opts.capturedAgentOpts.current = agentOpts
      return fake.session as any
    }),
  }

  return { deps, events, idbCalls, fake }
}

describe('agentService.runTurn', () => {
  it('emits fatalError when no apiKey is configured', async () => {
    const { deps, events } = makeDeps({
      settings: defaultSettings({ apiKey: '' }),
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('fatalError')
    expect(events[0].code).toBe('no_api_key')
    expect(deps.appendMessage).not.toHaveBeenCalled()
    expect(deps.createAgent).not.toHaveBeenCalled()
  })

  it('persistent path writes user msg + reads history + writes assistant placeholder + finalizes', async () => {
    const { deps, events, idbCalls } = makeDeps({})
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hello' })

    // Order: append user → list history → append assistant placeholder → update assistant on done
    expect(idbCalls).toEqual(['append:user', 'list', 'append:assistant', 'update'])

    // Wire events emitted: user appended, assistant pending placeholder, streamChunk, terminal assistant.
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual([
      'message/appended', // user
      'message/appended', // empty assistant placeholder pending=true
      'message/streamChunk',
      'message/appended', // terminal assistant pending=false
    ])
    expect(events[0].message.role).toBe('user')
    expect(events[1].message.role).toBe('assistant')
    expect(events[1].message.pending).toBe(true)
    expect(events[3].message.role).toBe('assistant')
    expect(events[3].message.pending).toBe(false)
    expect(events[3].message.content).toBe('hello')
  })

  it('ephemeral path skips IDB entirely', async () => {
    const { deps, events, idbCalls } = makeDeps({})
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi', ephemeral: true })

    expect(idbCalls).toEqual([])
    expect(deps.appendMessage).not.toHaveBeenCalled()
    expect(deps.listMessagesByConversation).not.toHaveBeenCalled()
    expect(deps.updateMessage).not.toHaveBeenCalled()
    expect(deps.activeConversationId).not.toHaveBeenCalled()

    // Wire shape preserved — UI consumers see the same event sequence as the persistent path.
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual([
      'message/appended',
      'message/appended',
      'message/streamChunk',
      'message/appended',
    ])
  })

  it('tools allowlist filters the tool set passed to createAgent', async () => {
    const fakeTool = (name: string): ToolDefinition<any, any, any> =>
      ({ name, description: '', inputSchema: {}, execute: async () => ({ ok: true, data: {} }) }) as any
    const captured = { current: undefined as any }
    const { deps } = makeDeps({
      tools: [fakeTool('readPage'), fakeTool('querySelector'), fakeTool('screenshot')],
      capturedAgentOpts: captured,
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({
      sessionId: 's1',
      text: 'hi',
      ephemeral: true,
      tools: ['readPage'],
    })

    expect(captured.current.tools).toHaveLength(1)
    expect(captured.current.tools[0].name).toBe('readPage')
  })

  it('per-request system / model overrides flow into createAgent', async () => {
    const captured = { current: undefined as any }
    const { deps } = makeDeps({
      settings: defaultSettings({
        systemPromptAddendum: 'global system',
        model: 'global-model',
      }),
      capturedAgentOpts: captured,
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({
      sessionId: 's1',
      text: 'hi',
      ephemeral: true,
      system: 'override system',
      model: 'override-model',
    })

    expect(captured.current.systemPrompt).toBe('override system')
    expect(captured.current.llm.model).toBe('override-model')
  })

  it('falls back to global settings when overrides absent', async () => {
    const captured = { current: undefined as any }
    const { deps } = makeDeps({
      settings: defaultSettings({
        systemPromptAddendum: 'global system',
        model: 'global-model',
      }),
      capturedAgentOpts: captured,
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi', ephemeral: true })

    expect(captured.current.systemPrompt).toBe('global system')
    expect(captured.current.llm.model).toBe('global-model')
  })

  it('forwards history (excluding the just-appended user message) to agent.send', async () => {
    const captured = { current: undefined as any }
    const fake = makeFakeAgent([
      { kind: 'done', stopReason: 'end_turn', assistantText: 'ok' },
    ])
    let sendArgs: any
    const session = {
      ...fake.session,
      send: (text: string, opts?: any) => {
        sendArgs = { text, opts }
        return fake.session.send()
      },
      cancel: fake.session.cancel,
    }
    const deps: any = {
      loadSettings: async () => defaultSettings(),
      emit: () => {},
      appendMessage: vi.fn(async (m) => ({
        id: m.role === 'user' ? 'user-id' : 'assistant-id',
        createdAt: 0,
      })),
      listMessagesByConversation: vi.fn(async () => [
        { id: 'old-1', role: 'user', content: 'first turn user' },
        { id: 'old-2', role: 'assistant', content: 'first turn reply' },
        { id: 'user-id', role: 'user', content: 'this turn — should be filtered' },
        { id: 'cmp-1', role: 'system-synth', content: 'compacted', compacted: true },
      ]),
      updateMessage: vi.fn(),
      activeConversationId: vi.fn(async () => 'conv-1'),
      buildToolContext: vi.fn(async () => ({
        rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
        tabId: undefined,
        conversationId: 'conv-1',
      })),
      createAgent: () => session,
    }

    const svc = createAgentService(deps)
    await svc.runTurn({ sessionId: 's1', text: 'this turn' })

    expect(sendArgs.text).toBe('this turn')
    expect(sendArgs.opts.history).toHaveLength(2)
    expect(sendArgs.opts.history[0].content).toBe('first turn user')
    expect(sendArgs.opts.history[1].content).toBe('first turn reply')
  })

  it('invokes onAbortable with a cancel that stops the stream', async () => {
    const events: any[] = []
    const agentEvents: CoreAgentEvent[] = [
      { kind: 'message/streamChunk', delta: 'a' },
      { kind: 'message/streamChunk', delta: 'b' },
      { kind: 'message/streamChunk', delta: 'c' },
      { kind: 'done', stopReason: 'cancel', assistantText: 'a' },
    ]
    const fake = makeFakeAgent(agentEvents)
    const deps: any = {
      loadSettings: async () => defaultSettings(),
      emit: (ev: any) => events.push(ev),
      appendMessage: async () => ({ id: 'x', createdAt: 0 }),
      listMessagesByConversation: async () => [],
      updateMessage: async () => {},
      activeConversationId: async () => 'conv-1',
      buildToolContext: async () => ({
        rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
        tabId: undefined,
        conversationId: 'conv-1',
      }),
      createAgent: () => fake.session,
    }
    let cancelFn: (() => void) | undefined
    const svc = createAgentService(deps)
    await svc.runTurn(
      { sessionId: 's1', text: 'go', ephemeral: true },
      (cancel) => {
        cancelFn = cancel
        cancel() // cancel immediately so the stream halts after first iteration
      },
    )

    expect(typeof cancelFn).toBe('function')
    expect(fake.cancelled.value).toBe(true)
  })

  it('emits engine_error fatalError when the agent stream throws', async () => {
    const events: any[] = []
    const session = {
      send: () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error('boom')
        },
      }),
      cancel: () => {},
    }
    const deps: any = {
      loadSettings: async () => defaultSettings(),
      emit: (ev: any) => events.push(ev),
      appendMessage: async () => ({ id: 'x', createdAt: 0 }),
      listMessagesByConversation: async () => [],
      updateMessage: async () => {},
      activeConversationId: async () => 'conv-1',
      buildToolContext: async () => ({
        rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
        tabId: undefined,
        conversationId: 'conv-1',
      }),
      createAgent: () => session,
    }
    const svc = createAgentService(deps)
    await svc.runTurn({ sessionId: 's1', text: 'go', ephemeral: true })

    const fatal = events.find((e) => e.kind === 'fatalError')
    expect(fatal).toBeDefined()
    expect(fatal.code).toBe('engine_error')
    expect(fatal.message).toContain('boom')
  })
})
