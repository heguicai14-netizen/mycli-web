import { describe, it, expect, vi } from 'vitest'
import {
  QueryEngine,
  ApprovalCoordinator,
  type OpenAICompatibleClient,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
} from 'agent-kernel'

function fakeClient(batches: StreamEvent[][]): OpenAICompatibleClient {
  let i = 0
  return {
    async *streamChat() {
      const b = batches[i++] ?? []
      for (const ev of b) yield ev
    },
  } as Pick<OpenAICompatibleClient, 'streamChat'> as OpenAICompatibleClient
}

const fakeTool = (
  overrides: Partial<ToolDefinition<any, any, any>> = {},
): ToolDefinition<any, any, any> => ({
  name: 'dangerous',
  description: 'x',
  inputSchema: {},
  execute: vi.fn().mockResolvedValue({ ok: true, data: 'tool-result' }),
  requiresApproval: true,
  ...overrides,
})

const fakeOpenAiToolSchema = {
  type: 'function' as const,
  function: { name: 'dangerous', description: 'x', parameters: {} },
}

describe('QueryEngine approval gate', () => {
  it('gates tool with requiresApproval=true through coordinator', async () => {
    const tool = fakeTool()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('allow') },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: { x: 1 } }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    expect((tool.execute as any)).toHaveBeenCalledTimes(1)
  })

  it('skips tool when coordinator returns deny and pushes synthetic tool_result', async () => {
    const tool = fakeTool()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('deny') },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: {} }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    expect((tool.execute as any)).not.toHaveBeenCalled()
    const toolResult = out.find((e) => e.kind === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content).toMatch(/denied/i)
  })

  it('does not gate when tool.requiresApproval is undefined', async () => {
    const tool = fakeTool({ requiresApproval: undefined })
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('deny') },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: {} }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    expect((tool.execute as any)).toHaveBeenCalledTimes(1)
  })

  it('uses buildApprovalContext to populate req.ctx', async () => {
    const tool = fakeTool()
    const checkSpy = vi.fn().mockResolvedValue('allow')
    const coord = new ApprovalCoordinator({
      adapter: { check: checkSpy },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: { selector: '#x' } }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
      buildApprovalContext: (call) => ({
        origin: 'https://example.com',
        selector: (call.input as any)?.selector,
      }),
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    const arg = (checkSpy as any).mock.calls[0][0]
    expect(arg.ctx).toEqual({ origin: 'https://example.com', selector: '#x' })
  })

  it('uses tool.summarizeArgs when provided', async () => {
    const summarize = vi.fn().mockReturnValue('custom summary')
    const tool = fakeTool({ summarizeArgs: summarize })
    const emit = vi.fn()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('ask') },
      emit,
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: { a: 1 } }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const runP = (async () => {
      const out: any[] = []
      for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
      return out
    })()
    await new Promise((r) => setTimeout(r, 0))
    expect(summarize).toHaveBeenCalledWith({ a: 1 })
    const emitArg = emit.mock.calls[0][0]
    expect(emitArg.summary).toBe('custom summary')
    coord.resolve(emitArg.approvalId, 'once')
    await runP
  })

  it('throws when approvalCoordinator is set but sessionId is missing', async () => {
    const tool = fakeTool()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('ask') },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: {} }],
        },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      // sessionId intentionally omitted
    })
    let err: unknown
    try {
      for await (const _ev of engine.run([{ role: 'user', content: 'go' }])) {
        // drain
      }
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).toMatch(/sessionId/i)
    expect(tool.execute as any).not.toHaveBeenCalled()
  })

  it('deny path emits paired tool_executing + tool_result events', async () => {
    const tool = fakeTool()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('deny') },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: {} }],
        },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [fakeOpenAiToolSchema],
      toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord,
      sessionId: 'sess',
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    const executingIdx = out.findIndex((e) => e.kind === 'tool_executing')
    const resultIdx = out.findIndex((e) => e.kind === 'tool_result')
    expect(executingIdx).toBeGreaterThanOrEqual(0)
    expect(resultIdx).toBeGreaterThan(executingIdx)
    expect(out[resultIdx].isError).toBe(true)
    expect((tool.execute as any)).not.toHaveBeenCalled()
  })

  it('falls back gracefully when summarizeArgs throws', async () => {
    const tool = fakeTool({
      summarizeArgs: () => { throw new Error('boom') },
    })
    const emit = vi.fn()
    const coord = new ApprovalCoordinator({
      adapter: { check: vi.fn().mockResolvedValue('ask') },
      emit,
    })
    const client = fakeClient([
      [
        { kind: 'done', stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: { a: 1 } }] },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = new QueryEngine({
      client, tools: [fakeOpenAiToolSchema], toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord, sessionId: 'sess',
    })
    const runP = (async () => {
      const out: any[] = []
      for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
      return out
    })()
    await new Promise((r) => setTimeout(r, 0))
    expect(emit).toHaveBeenCalledTimes(1)
    const emitArg = emit.mock.calls[0][0]
    // Fallback summary should be JSON of args
    expect(emitArg.summary).toBe(JSON.stringify({ a: 1 }).slice(0, 200))
    expect(warn).toHaveBeenCalled()
    coord.resolve(emitArg.approvalId, 'once')
    await runP
    warn.mockRestore()
  })

  it('falls back to {} when buildApprovalContext throws', async () => {
    const tool = fakeTool()
    const checkSpy = vi.fn().mockResolvedValue('allow')
    const coord = new ApprovalCoordinator({
      adapter: { check: checkSpy },
      emit: vi.fn(),
    })
    const client = fakeClient([
      [
        { kind: 'done', stopReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'dangerous', input: {} }] },
      ],
      [{ kind: 'done', stopReason: 'stop' }],
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = new QueryEngine({
      client, tools: [fakeOpenAiToolSchema], toolDefinitions: [tool],
      executeTool: tool.execute as any,
      approvalCoordinator: coord, sessionId: 'sess',
      buildApprovalContext: () => { throw new Error('boom') },
    })
    const out: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) out.push(ev)
    expect(checkSpy).toHaveBeenCalled()
    expect(checkSpy.mock.calls[0][0].ctx).toEqual({})
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
