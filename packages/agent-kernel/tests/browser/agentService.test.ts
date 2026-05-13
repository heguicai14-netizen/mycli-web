import { describe, it, expect, vi } from 'vitest'
import { createAgentService } from 'agent-kernel'
import type { AgentEvent as CoreAgentEvent, ToolDefinition } from 'agent-kernel'
import { ApprovalCoordinator } from 'agent-kernel'
import type { TodoStoreAdapter, TodoItem } from 'agent-kernel'

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
  approvalCoordinator?: ApprovalCoordinator
  todoStore?: TodoStoreAdapter
}) {
  const events: any[] = []
  const idbCalls: string[] = []
  const fake = makeFakeAgent(
    opts.agentEvents ?? [
      { kind: 'message/streamChunk', delta: 'hello' },
      { kind: 'done', stopReason: 'end_turn', assistantText: 'hello' },
    ],
  )

  const messageStore = {
    append: vi.fn(async (msg: any) => {
      idbCalls.push(`append:${msg.role}`)
      return { id: `msg-${idbCalls.length}`, createdAt: 1000 + idbCalls.length }
    }),
    list: vi.fn(async () => {
      idbCalls.push('list')
      return opts.history ?? []
    }),
    update: vi.fn(async () => {
      idbCalls.push('update')
    }),
    activeConversationId: vi.fn(async () => 'conv-1'),
  }

  const deps = {
    settings: { load: async () => opts.settings ?? defaultSettings() },
    emit: (ev: any) => {
      events.push(ev)
    },
    messageStore,
    toolContext: {
      build: vi.fn(async () => ({
        rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
        tabId: 99,
        conversationId: 'conv-1',
      })),
    },
    tools: opts.tools,
    createAgent: vi.fn((agentOpts: any) => {
      if (opts.capturedAgentOpts) opts.capturedAgentOpts.current = agentOpts
      return fake.session as any
    }),
    approvalCoordinator: opts.approvalCoordinator,
    todoStore: opts.todoStore,
  }

  return { deps, events, idbCalls, fake, messageStore }
}

describe('agentService.runTurn', () => {
  it('emits fatalError when no apiKey is configured', async () => {
    const { deps, events, messageStore } = makeDeps({
      settings: defaultSettings({ apiKey: '' }),
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('fatalError')
    expect(events[0].code).toBe('no_api_key')
    expect(messageStore.append).not.toHaveBeenCalled()
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
    const { deps, events, idbCalls, messageStore } = makeDeps({})
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi', ephemeral: true })

    expect(idbCalls).toEqual([])
    expect(messageStore.append).not.toHaveBeenCalled()
    expect(messageStore.list).not.toHaveBeenCalled()
    expect(messageStore.update).not.toHaveBeenCalled()
    expect(messageStore.activeConversationId).not.toHaveBeenCalled()

    // Wire shape preserved — UI consumers see the same event sequence as the persistent path.
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual([
      'message/appended',
      'message/appended',
      'message/streamChunk',
      'message/appended',
    ])
  })

  it('forwards core usage events as wire message/usage tied to assistant msg', async () => {
    const { deps, events } = makeDeps({
      agentEvents: [
        { kind: 'message/streamChunk', delta: 'hi' },
        { kind: 'usage', input: 42, output: 7 } as any,
        { kind: 'done', stopReason: 'end_turn', assistantText: 'hi' },
      ],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    const usage = events.find((e) => e.kind === 'message/usage')
    expect(usage).toBeDefined()
    expect(usage.input).toBe(42)
    expect(usage.output).toBe(7)
    // Anchored on the assistant placeholder. Mock id sequence: msg-1 (user
    // append), msg-2 slot consumed by list(), msg-3 (assistant placeholder).
    expect(usage.messageId).toBe('msg-3')
    expect(usage.sessionId).toBe('s1')
  })

  it('forwards cached on wire message/usage when AgentSession reports it', async () => {
    const { deps, events } = makeDeps({
      agentEvents: [
        { kind: 'message/streamChunk', delta: 'hi' },
        { kind: 'usage', input: 42, output: 7, cached: 30 } as any,
        { kind: 'done', stopReason: 'end_turn', assistantText: 'hi' },
      ],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    const usage = events.find((e) => e.kind === 'message/usage')
    expect(usage).toBeDefined()
    expect(usage.cached).toBe(30)
    expect(usage.input).toBe(42)
    expect(usage.output).toBe(7)
  })

  it('omits cached field on wire message/usage when AgentSession does not report it', async () => {
    const { deps, events } = makeDeps({
      agentEvents: [
        { kind: 'message/streamChunk', delta: 'hi' },
        { kind: 'usage', input: 42, output: 7 } as any,
        { kind: 'done', stopReason: 'end_turn', assistantText: 'hi' },
      ],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    const usage = events.find((e) => e.kind === 'message/usage')
    expect(usage).toBeDefined()
    expect(usage.cached).toBeUndefined()
    // Stricter: cached property should NOT be on the object at all (conditional spread)
    expect('cached' in usage).toBe(false)
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
    // agentService now constructs the OpenAICompatibleClient once and passes
    // it as `llmClient` so it can be shared with the Task tool. Reach into
    // the private cfg field (runtime access) to verify the resolved model.
    expect((captured.current.llmClient as any).cfg.model).toBe('override-model')
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
    expect((captured.current.llmClient as any).cfg.model).toBe('global-model')
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
      settings: { load: async () => defaultSettings() },
      emit: () => {},
      messageStore: {
        append: vi.fn(async (m) => ({
          id: m.role === 'user' ? 'user-id' : 'assistant-id',
          createdAt: 0,
        })),
        list: vi.fn(async () => [
          { id: 'old-1', role: 'user', content: 'first turn user' },
          { id: 'old-2', role: 'assistant', content: 'first turn reply' },
          { id: 'user-id', role: 'user', content: 'this turn — should be filtered' },
          { id: 'cmp-1', role: 'system-synth', content: 'compacted', compacted: true },
        ]),
        update: vi.fn(),
        activeConversationId: vi.fn(async () => 'conv-1'),
      },
      toolContext: {
        build: vi.fn(async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: undefined,
          conversationId: 'conv-1',
        })),
      },
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
      settings: { load: async () => defaultSettings() },
      emit: (ev: any) => events.push(ev),
      messageStore: {
        append: async () => ({ id: 'x', createdAt: 0 }),
        list: async () => [],
        update: async () => {},
        activeConversationId: async () => 'conv-1',
      },
      toolContext: {
        build: async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: undefined,
          conversationId: 'conv-1',
        }),
      },
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

  // ---------- Tool result truncation ----------

  it('buildPriorHistory truncates large tool rows for the LLM but not in IDB', async () => {
    const big = 'X'.repeat(50_000)
    const history = [
      { id: 'u1', role: 'user', content: 'q', compacted: false },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        compacted: false,
        toolCalls: [{ id: 'c1', name: 'readPage', input: {} }],
      },
      {
        id: 't1',
        role: 'tool',
        content: big,
        compacted: false,
        toolCallId: 'c1',
      },
      { id: 'a2', role: 'assistant', content: 'short', compacted: false },
    ]
    let capturedHistory: any[] = []
    const fake = makeFakeAgent([
      { kind: 'message/streamChunk', delta: 'ok' },
      { kind: 'done', stopReason: 'end_turn', assistantText: 'ok' },
    ])
    const session = {
      send: (_text: string, opts: any) => {
        capturedHistory = opts.history
        return fake.session.send()
      },
      cancel: fake.session.cancel,
    }
    const deps: any = {
      settings: {
        load: async () =>
          defaultSettings({ toolMaxOutputChars: 1000 }),
      },
      emit: () => {},
      messageStore: {
        append: vi.fn(async () => ({ id: 'new', createdAt: 999 })),
        list: vi.fn(async () => history),
        update: vi.fn(async () => {}),
        activeConversationId: vi.fn(async () => 'conv-1'),
        markCompacted: vi.fn(async () => {}),
      },
      toolContext: {
        build: async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: 99,
          conversationId: 'conv-1',
        }),
      },
      createAgent: () => session as any,
    }
    const svc = createAgentService(deps)
    await svc.runTurn({ sessionId: 's1', text: 'next' })

    // Tool message in the history sent to LLM is truncated.
    const toolMsg = capturedHistory.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content.length).toBeLessThan(big.length)
    expect(toolMsg.content).toContain('truncated by mycli-web')
    expect(toolMsg.content).toContain('original was 50000 chars')
    // IDB row content remains untouched (proxy: messageStore.list still
    // returns the full content; we never mutated it).
    expect(history[2].content).toBe(big)
  })

  it('buildPriorHistory leaves tool rows alone when toolMaxOutputChars is 0 or undefined', async () => {
    const big = 'Y'.repeat(20_000)
    const history = [
      { id: 'u1', role: 'user', content: 'q', compacted: false },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        compacted: false,
        toolCalls: [{ id: 'c1', name: 'fetchGet', input: {} }],
      },
      { id: 't1', role: 'tool', content: big, compacted: false, toolCallId: 'c1' },
    ]
    let capturedHistory: any[] = []
    const fake = makeFakeAgent([
      { kind: 'done', stopReason: 'end_turn', assistantText: '' },
    ])
    const session = {
      send: (_text: string, opts: any) => {
        capturedHistory = opts.history
        return fake.session.send()
      },
      cancel: fake.session.cancel,
    }
    const deps: any = {
      settings: { load: async () => defaultSettings({ toolMaxOutputChars: 0 }) },
      emit: () => {},
      messageStore: {
        append: vi.fn(async () => ({ id: 'new', createdAt: 999 })),
        list: vi.fn(async () => history),
        update: vi.fn(async () => {}),
        activeConversationId: vi.fn(async () => 'conv-1'),
        markCompacted: vi.fn(async () => {}),
      },
      toolContext: {
        build: async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: 99,
          conversationId: 'conv-1',
        }),
      },
      createAgent: () => session as any,
    }
    const svc = createAgentService(deps)
    await svc.runTurn({ sessionId: 's1', text: 'next' })
    const toolMsg = capturedHistory.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toBe(big)
    expect(toolMsg.content).not.toContain('truncated')
  })

  it('forwards toolMaxOutputChars through createAgent so QueryEngine sees it', async () => {
    const captured = { current: undefined as any }
    const { deps } = makeDeps({
      settings: defaultSettings({ toolMaxOutputChars: 5000 }),
      capturedAgentOpts: captured,
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi', ephemeral: true })
    expect(captured.current.toolMaxOutputChars).toBe(5000)
  })

  // ---------- Tool persistence ----------

  it('persists multi-iteration turn as separate assistant + tool rows with toolCalls/toolCallId', async () => {
    const events: any[] = []
    const appended: any[] = []
    const updated: Array<{ id: string; patch: any }> = []
    const live: any[] = []

    const messageStore = {
      append: vi.fn(async (msg: any) => {
        const id = `m-${appended.length + 1}`
        appended.push({ ...msg, id })
        live.push({ ...msg, id, compacted: false })
        return { id, createdAt: 1000 + appended.length }
      }),
      list: vi.fn(async () => live),
      update: vi.fn(async (id: string, patch: any) => {
        updated.push({ id, patch })
        const row = live.find((m) => m.id === id)
        if (row) Object.assign(row, patch)
      }),
      activeConversationId: vi.fn(async () => 'conv-1'),
      markCompacted: vi.fn(async () => {}),
    }

    const fake = makeFakeAgent([
      // iter 1: empty text + a tool call
      { kind: 'assistant/iter', text: '', toolCalls: [{ id: 'c1', name: 'readPage', input: { selector: 'h1' } }] } as any,
      { kind: 'tool/start', toolCall: { id: 'c1', tool: 'readPage', args: { selector: 'h1' } } },
      { kind: 'tool/end', toolCallId: 'c1', result: { ok: true, content: '<h1>Hello</h1>' } },
      // iter 2: final assistant text, no tool calls
      { kind: 'message/streamChunk', delta: 'The page title is Hello.' },
      { kind: 'assistant/iter', text: 'The page title is Hello.', toolCalls: [] } as any,
      { kind: 'done', stopReason: 'end_turn', assistantText: 'The page title is Hello.' },
    ])

    const deps: any = {
      settings: { load: async () => defaultSettings() },
      emit: (ev: any) => events.push(ev),
      messageStore,
      toolContext: {
        build: async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: 99,
          conversationId: 'conv-1',
        }),
      },
      createAgent: () => fake.session as any,
    }

    const svc = createAgentService(deps)
    await svc.runTurn({ sessionId: 's1', text: 'what is the page title' })

    // Storage shape:
    //  m-1 user
    //  m-2 assistant (iter 1, empty text, toolCalls=[c1])
    //  m-3 tool (toolCallId=c1)
    //  m-4 assistant (iter 2, "The page title is Hello.", no toolCalls)
    const userRow = appended.find((r) => r.role === 'user')
    expect(userRow).toBeDefined()

    const assistantRows = appended.filter((r) => r.role === 'assistant')
    expect(assistantRows).toHaveLength(2)

    const toolRows = appended.filter((r) => r.role === 'tool')
    expect(toolRows).toHaveLength(1)
    expect(toolRows[0].toolCallId).toBe('c1')
    expect(toolRows[0].content).toBe('<h1>Hello</h1>')

    // First assistant row was finalized via update() to include the tool call.
    const iter1Update = updated.find(
      (u) => u.patch.toolCalls && u.patch.toolCalls.length > 0,
    )
    expect(iter1Update).toBeDefined()
    expect(iter1Update!.patch.toolCalls[0].id).toBe('c1')
    expect(iter1Update!.patch.toolCalls[0].name).toBe('readPage')
    expect(iter1Update!.patch.pending).toBe(false)

    // Wire: tool row is emitted as message/appended too (so snapshots replay it
    // even though the chat UI filters it out).
    const toolAppendedEv = events.find(
      (e) => e.kind === 'message/appended' && e.message.role === 'tool',
    )
    expect(toolAppendedEv).toBeDefined()
    expect(toolAppendedEv.message.content).toBe('<h1>Hello</h1>')
  })

  it('buildPriorHistory maps assistant.toolCalls and tool.toolCallId to OpenAI ChatMessage shape', async () => {
    const events: any[] = []
    // History from a previous turn: user → assistant(text + toolCalls) → tool result → assistant(final)
    const history = [
      { id: 'u1', role: 'user', content: 'find the title', compacted: false },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        compacted: false,
        toolCalls: [{ id: 'c1', name: 'readPage', input: { selector: 'h1' } }],
      },
      {
        id: 't1',
        role: 'tool',
        content: '<h1>Hello</h1>',
        compacted: false,
        toolCallId: 'c1',
      },
      { id: 'a2', role: 'assistant', content: 'The title is Hello.', compacted: false },
    ]
    let capturedHistory: any[] = []
    const fake = makeFakeAgent([
      { kind: 'message/streamChunk', delta: 'ok' },
      { kind: 'done', stopReason: 'end_turn', assistantText: 'ok' },
    ])
    const session = {
      send: (_text: string, opts: any) => {
        capturedHistory = opts.history
        return fake.session.send()
      },
      cancel: fake.session.cancel,
    }
    const deps: any = {
      settings: { load: async () => defaultSettings() },
      emit: (ev: any) => events.push(ev),
      messageStore: {
        append: vi.fn(async (msg: any) => ({ id: 'new', createdAt: 999 })),
        list: vi.fn(async () => history),
        update: vi.fn(async () => {}),
        activeConversationId: vi.fn(async () => 'conv-1'),
        markCompacted: vi.fn(async () => {}),
      },
      toolContext: {
        build: async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: 99,
          conversationId: 'conv-1',
        }),
      },
      createAgent: () => session as any,
    }
    const svc = createAgentService(deps)
    await svc.runTurn({ sessionId: 's1', text: 'next question' })

    // Captured history sent to LLM should mirror OpenAI's expected shape:
    //   user, assistant(with tool_calls), tool(with tool_call_id), assistant
    expect(capturedHistory).toHaveLength(4)
    expect(capturedHistory[0]).toMatchObject({ role: 'user', content: 'find the title' })

    expect(capturedHistory[1].role).toBe('assistant')
    expect(capturedHistory[1].tool_calls).toBeDefined()
    expect(capturedHistory[1].tool_calls[0].id).toBe('c1')
    expect(capturedHistory[1].tool_calls[0].type).toBe('function')
    expect(capturedHistory[1].tool_calls[0].function.name).toBe('readPage')
    expect(JSON.parse(capturedHistory[1].tool_calls[0].function.arguments)).toEqual({
      selector: 'h1',
    })

    expect(capturedHistory[2].role).toBe('tool')
    expect(capturedHistory[2].tool_call_id).toBe('c1')
    expect(capturedHistory[2].content).toBe('<h1>Hello</h1>')

    expect(capturedHistory[3]).toMatchObject({
      role: 'assistant',
      content: 'The title is Hello.',
    })
    expect(capturedHistory[3].tool_calls).toBeUndefined()
  })

  // ---------- Auto-compaction ----------

  function compactionScenario(opts: {
    enabled?: boolean
    history: Array<{ id: string; role: string; content: string; compacted?: boolean }>
    threshold?: number
    keep?: number
    summary?: string
    compactThrows?: Error
    ephemeral?: boolean
  }) {
    const events: any[] = []
    const compacted: string[][] = []
    const appended: any[] = []
    const ac = opts.enabled === false
      ? undefined
      : {
          enabled: true,
          modelContextWindow: 1000,
          thresholdPercent: opts.threshold ?? 50, // default threshold = 500 chars/4≈125 toks
          keepRecentMessages: opts.keep ?? 2,
        }
    const settings = defaultSettings({ autoCompact: ac })
    // Stateful mock: list() reflects markCompacted (filters out) and append()
    // (adds new rows). This matches real IDB behavior and lets the test verify
    // that compaction shrinks the rebuilt history.
    const live = opts.history.map((h) => ({ ...h, compacted: !!h.compacted }))
    const compactedSet = new Set<string>()
    const messageStore = {
      append: vi.fn(async (msg: any) => {
        appended.push(msg)
        const id = `new-${appended.length}`
        live.push({ id, role: msg.role, content: msg.content, compacted: false } as any)
        return { id, createdAt: 9000 + appended.length }
      }),
      list: vi.fn(async () =>
        live.map((m) => ({ ...m, compacted: m.compacted || compactedSet.has(m.id) })),
      ),
      update: vi.fn(async () => {}),
      activeConversationId: vi.fn(async () => 'conv-1'),
      markCompacted: vi.fn(async (ids: string[]) => {
        compacted.push(ids)
        for (const id of ids) compactedSet.add(id)
      }),
    }
    const fake = makeFakeAgent([
      { kind: 'message/streamChunk', delta: 'ok' },
      { kind: 'done', stopReason: 'end_turn', assistantText: 'ok' },
    ])
    const compact = vi.fn(async () => {
      if (opts.compactThrows) throw opts.compactThrows
      return opts.summary ?? 'Goals: do stuff. Facts: x=1. Open: none.'
    })
    const deps = {
      settings: { load: async () => settings },
      emit: (ev: any) => events.push(ev),
      messageStore,
      toolContext: {
        build: async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: 99,
          conversationId: 'conv-1',
        }),
      },
      createAgent: () => fake.session as any,
      compact,
    } as any
    const svc = createAgentService(deps)
    return { svc, events, compact, messageStore, appended, compacted }
  }

  // Build a long history that easily exceeds threshold = 500 (1000 * 50% = 500 toks ≈ 2000 chars)
  const longContent = 'lorem ipsum dolor sit amet '.repeat(200) // ~5400 chars > 1350 toks
  const longHistory = [
    { id: 'h1', role: 'user', content: longContent },
    { id: 'h2', role: 'assistant', content: longContent },
    { id: 'h3', role: 'user', content: 'recent question one' },
    { id: 'h4', role: 'assistant', content: 'recent answer one' },
  ]

  it('triggers compaction when prior history exceeds threshold', async () => {
    const { svc, events, compact, messageStore } = compactionScenario({
      history: longHistory,
    })
    await svc.runTurn({ sessionId: 's1', text: 'next question' })

    const started = events.find((e) => e.kind === 'compact/started')
    const completed = events.find((e) => e.kind === 'compact/completed')
    expect(started).toBeDefined()
    expect(completed).toBeDefined()
    expect(started.threshold).toBe(500)
    expect(started.messagesToCompact).toBe(2) // 4 - keep(2) = 2 head
    expect(compact).toHaveBeenCalledTimes(1)
    expect(messageStore.markCompacted).toHaveBeenCalledWith(['h1', 'h2'])
    expect(completed.summaryMessageId).toBeDefined()
    expect(completed.afterTokens).toBeLessThan(completed.beforeTokens)
  })

  it('skips compaction when threshold not exceeded', async () => {
    const shortHistory = [
      { id: 'h1', role: 'user', content: 'hi' },
      { id: 'h2', role: 'assistant', content: 'hello' },
      { id: 'h3', role: 'user', content: 'how are you' },
      { id: 'h4', role: 'assistant', content: 'fine' },
    ]
    const { svc, events, compact, messageStore } = compactionScenario({
      history: shortHistory,
    })
    await svc.runTurn({ sessionId: 's1', text: 'ok' })

    expect(compact).not.toHaveBeenCalled()
    expect(messageStore.markCompacted).not.toHaveBeenCalled()
    expect(events.find((e) => e.kind === 'compact/started')).toBeUndefined()
  })

  it('skips compaction when autoCompact is disabled', async () => {
    const { svc, events, compact } = compactionScenario({
      enabled: false,
      history: longHistory,
    })
    await svc.runTurn({ sessionId: 's1', text: 'q' })
    expect(compact).not.toHaveBeenCalled()
    expect(events.find((e) => e.kind === 'compact/started')).toBeUndefined()
  })

  it('skips compaction for ephemeral turns', async () => {
    const { svc, events, compact } = compactionScenario({
      history: longHistory,
    })
    await svc.runTurn({ sessionId: 's1', text: 'q', ephemeral: true })
    expect(compact).not.toHaveBeenCalled()
    expect(events.find((e) => e.kind === 'compact/started')).toBeUndefined()
  })

  it('emits compact/failed and continues with full history when compactor throws', async () => {
    const { svc, events, compact, messageStore } = compactionScenario({
      history: longHistory,
      compactThrows: new Error('rate_limit'),
    })
    await svc.runTurn({ sessionId: 's1', text: 'q' })

    const failed = events.find((e) => e.kind === 'compact/failed')
    expect(failed).toBeDefined()
    expect(failed.reason).toBe('rate_limit')
    expect(messageStore.markCompacted).not.toHaveBeenCalled()
    // The agent stream still ran (assistant message was emitted at end)
    expect(events.some((e) => e.kind === 'message/streamChunk')).toBe(true)
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('emits message/appended for the system-synth summary so UI can display it', async () => {
    const { svc, events } = compactionScenario({
      history: longHistory,
      summary: 'Goals: X. Facts: Y. Open: Z.',
    })
    await svc.runTurn({ sessionId: 's1', text: 'q' })

    const synthMsgEv = events
      .filter((e) => e.kind === 'message/appended')
      .find((e) => e.message.role === 'system-synth')
    expect(synthMsgEv).toBeDefined()
    expect(synthMsgEv.message.content).toBe('Goals: X. Facts: Y. Open: Z.')
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
      settings: { load: async () => defaultSettings() },
      emit: (ev: any) => events.push(ev),
      messageStore: {
        append: async () => ({ id: 'x', createdAt: 0 }),
        list: async () => [],
        update: async () => {},
        activeConversationId: async () => 'conv-1',
      },
      toolContext: {
        build: async () => ({
          rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
          tabId: undefined,
          conversationId: 'conv-1',
        }),
      },
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

describe('agentService approval flow', () => {
  it('routes wire approval/reply to coordinator.resolve', async () => {
    const fakeCoord = {
      resolve: vi.fn(),
      cancelSession: vi.fn(),
      gate: vi.fn(),
    } as unknown as ApprovalCoordinator

    const { deps } = makeDeps({ approvalCoordinator: fakeCoord })
    const svc = createAgentService(deps as any)

    svc.handleCommand?.({
      id: crypto.randomUUID(),
      sessionId: 's1',
      ts: Date.now(),
      kind: 'approval/reply',
      approvalId: 'a1',
      decision: 'session',
    })

    expect((fakeCoord.resolve as any)).toHaveBeenCalledWith('a1', 'session')
  })

  it('handleCommand is a no-op for unknown kinds', () => {
    const { deps } = makeDeps({})
    const svc = createAgentService(deps as any)
    // Should not throw
    svc.handleCommand?.({ kind: 'unknown/thing', sessionId: 's1' })
  })

  it('cancelSession is called when a turn cancels', async () => {
    const fakeCoord = {
      resolve: vi.fn(),
      cancelSession: vi.fn(),
      gate: vi.fn(),
    } as unknown as ApprovalCoordinator

    const { deps } = makeDeps({
      approvalCoordinator: fakeCoord,
      agentEvents: [
        { kind: 'message/streamChunk', delta: 'a' },
        { kind: 'done', stopReason: 'cancel', assistantText: 'a' },
      ],
    })

    const svc = createAgentService(deps as any)
    let cancelFn: (() => void) | undefined
    await svc.runTurn(
      { sessionId: 's1', text: 'q', ephemeral: true },
      (cancel) => {
        cancelFn = cancel
        cancel() // cancel immediately
      },
    )

    expect(typeof cancelFn).toBe('function')
    expect((fakeCoord.cancelSession as any)).toHaveBeenCalledWith(
      's1',
      expect.any(String),
    )
  })
})

// ---------- TodoStore / todo/updated integration ----------

const stubTodoStore = (overrides: Partial<TodoStoreAdapter> = {}): TodoStoreAdapter => ({
  list: vi.fn().mockResolvedValue([]),
  replace: vi.fn().mockResolvedValue([]),
  ...overrides,
})

describe('agentService todo flow', () => {
  it('emits wire todo/updated after a successful todoWrite tool call', async () => {
    const canonical: TodoItem[] = [
      { id: 't1', subject: 'A', status: 'pending', createdAt: 1, updatedAt: 1 },
    ]
    const todoStore = stubTodoStore({
      replace: vi.fn().mockResolvedValue(canonical),
    })
    const { deps, events } = makeDeps({
      todoStore,
      agentEvents: [
        {
          kind: 'tool/start',
          toolCall: { id: 'tc1', tool: 'todoWrite', args: { items: [{ subject: 'A', status: 'pending' }] } },
        },
        {
          kind: 'tool/end',
          toolCallId: 'tc1',
          result: {
            ok: true,
            content: JSON.stringify({ count: 1, items: canonical }),
          },
        },
        { kind: 'done', stopReason: 'end_turn', assistantText: '' },
      ] as any[],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'do it' })
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeDefined()
    expect(todoEvt.conversationId).toBeDefined()
    expect(todoEvt.items).toEqual(canonical)
  })

  it('does NOT emit todo/updated for non-todoWrite tools', async () => {
    const todoStore = stubTodoStore()
    const { deps, events } = makeDeps({
      todoStore,
      agentEvents: [
        {
          kind: 'tool/start',
          toolCall: { id: 'tc1', tool: 'readPage', args: {} },
        },
        {
          kind: 'tool/end',
          toolCallId: 'tc1',
          result: { ok: true, content: 'page content' },
        },
        { kind: 'done', stopReason: 'end_turn', assistantText: '' },
      ] as any[],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'read' })
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeUndefined()
  })

  it('does NOT emit todo/updated when todoWrite tool returns ok: false', async () => {
    const todoStore = stubTodoStore()
    const { deps, events } = makeDeps({
      todoStore,
      agentEvents: [
        {
          kind: 'tool/start',
          toolCall: { id: 'tc1', tool: 'todoWrite', args: { items: [] } },
        },
        {
          kind: 'tool/end',
          toolCallId: 'tc1',
          result: { ok: false, content: '{"code":"todo_persist_failed","message":"idb boom"}' },
        },
        { kind: 'done', stopReason: 'end_turn', assistantText: '' },
      ] as any[],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'do it' })
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeUndefined()
  })

  it('emits initial todo/updated when a conversation is loaded', async () => {
    const initial: TodoItem[] = [
      { id: 't1', subject: 'X', status: 'pending', createdAt: 1, updatedAt: 1 },
    ]
    const todoStore = stubTodoStore({
      list: vi.fn().mockResolvedValue(initial),
    })
    const { deps, events } = makeDeps({
      todoStore,
    })
    const svc = createAgentService(deps as any)
    await svc.handleCommand?.({
      id: crypto.randomUUID(),
      sessionId: 's1',
      ts: Date.now(),
      kind: 'chat/loadConversation',
      conversationId: 'cv1',
    } as any)
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeDefined()
    expect(todoEvt.items).toEqual(initial)
  })
})
