import { describe, it, expect, vi } from 'vitest'
import {
  createAgentService,
  buildSubagentTypeRegistry,
  type SubagentType,
  type ToolDefinition,
  type AgentEvent as CoreAgentEvent,
} from 'agent-kernel'

// Covers the wiring inside agentService.runTurn that the unit tests for
// Subagent / taskTool / bootKernelOffscreen each cover in isolation but no
// test exercised together: when subagentTypeRegistry is provided, agentService
// must (a) append a freshly-built Task tool to the per-turn tool list,
// (b) stash __taskParentRegistry on the ToolExecContext so the Task tool can
// derive the child registry, (c) populate emitSubagentEvent so sub-agent
// lifecycle events reach the wire with the standard envelope.

const gp: SubagentType = {
  name: 'general-purpose',
  description: 'GP agent',
  systemPrompt: 'sys',
  allowedTools: '*',
}

function defaultSettings() {
  return {
    apiKey: 'k',
    baseUrl: 'http://x.local/v1',
    model: 'm',
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
  } as any
}

function makeFakeSession(events: CoreAgentEvent[]) {
  return {
    send: () => ({
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev
      },
    }),
    cancel: () => {},
  }
}

const probeTool: ToolDefinition<{ x?: number }, string> = {
  name: 'probe',
  description: 'probe',
  inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
  async execute() {
    return { ok: true, data: 'ok' }
  },
}

function makeDeps(opts: {
  capturedAgentOpts: { current: any }
  tools: ToolDefinition<any, any, any>[]
  subagentTypeRegistry?: ReturnType<typeof buildSubagentTypeRegistry>
  events?: any[]
}) {
  const events = opts.events ?? []
  const messageStore = {
    append: vi.fn(async () => ({ id: 'm-1', createdAt: 1 })),
    list: vi.fn(async () => []),
    update: vi.fn(async () => {}),
    activeConversationId: vi.fn(async () => 'conv-1'),
  }
  return {
    settings: { load: async () => defaultSettings() },
    emit: (ev: any) => events.push(ev),
    messageStore,
    toolContext: {
      build: vi.fn(async () => ({
        rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
        tabId: 1,
      })),
    },
    tools: opts.tools,
    subagentTypeRegistry: opts.subagentTypeRegistry,
    createAgent: vi.fn((agentOpts: any) => {
      opts.capturedAgentOpts.current = agentOpts
      return makeFakeSession([
        { kind: 'message/streamChunk', delta: 'ok' },
        { kind: 'done', stopReason: 'end_turn', assistantText: 'ok' },
      ]) as any
    }),
  }
}

describe('agentService — subagent wiring', () => {
  it('does NOT append Task tool when subagentTypeRegistry is omitted', async () => {
    const captured = { current: null as any }
    const deps = makeDeps({ capturedAgentOpts: captured, tools: [probeTool] })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    const names: string[] = captured.current.tools.map((t: any) => t.name)
    expect(names).toContain('probe')
    expect(names).not.toContain('Task')
    // __taskParentRegistry is set unconditionally (harmless when no subagent
    // types are configured — the Task tool simply isn't registered to look it up).
    const parentReg = captured.current.toolContext.__taskParentRegistry
    expect(parentReg?.get('Task')).toBeUndefined()
  })

  it('appends Task tool + stashes __taskParentRegistry when registry is set', async () => {
    const captured = { current: null as any }
    const deps = makeDeps({
      capturedAgentOpts: captured,
      tools: [probeTool],
      subagentTypeRegistry: buildSubagentTypeRegistry([gp]),
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    const names: string[] = captured.current.tools.map((t: any) => t.name)
    expect(names).toContain('probe')
    expect(names).toContain('Task')

    const taskTool = captured.current.tools.find((t: any) => t.name === 'Task')
    expect(taskTool.description).toContain('general-purpose')
    expect(taskTool.description).toContain('GP agent')

    const parentReg = captured.current.toolContext.__taskParentRegistry
    expect(parentReg).toBeDefined()
    expect(parentReg.get('probe')).toBeDefined()
    expect(parentReg.get('Task')).toBeDefined()
  })

  it('emitSubagentEvent wraps payload with wire envelope', async () => {
    const captured = { current: null as any }
    const wireEvents: any[] = []
    const deps = makeDeps({
      capturedAgentOpts: captured,
      tools: [probeTool],
      subagentTypeRegistry: buildSubagentTypeRegistry([gp]),
      events: wireEvents,
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    const ctx = captured.current.toolContext
    expect(typeof ctx.emitSubagentEvent).toBe('function')

    ctx.emitSubagentEvent({
      kind: 'subagent/started',
      subagentId: 'sid-1',
      parentTurnId: ctx.turnId,
      parentCallId: 'call-1',
      subagentType: 'general-purpose',
      description: 'd',
      prompt: 'p',
      startedAt: 0,
    })

    const wire = wireEvents.find((e) => e.kind === 'subagent/started')
    expect(wire).toBeDefined()
    expect(wire.id).toBeTypeOf('string')
    expect(wire.sessionId).toBe('s1')
    expect(typeof wire.ts).toBe('number')
    expect(wire.subagentId).toBe('sid-1')
    expect(wire.subagentType).toBe('general-purpose')
  })

  it('per-turn turnId is populated on ToolExecContext', async () => {
    const captured = { current: null as any }
    const deps = makeDeps({
      capturedAgentOpts: captured,
      tools: [probeTool],
      subagentTypeRegistry: buildSubagentTypeRegistry([gp]),
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'hi' })

    expect(captured.current.toolContext.turnId).toBeTypeOf('string')
    expect(captured.current.toolContext.turnId.length).toBeGreaterThan(0)
  })
})
