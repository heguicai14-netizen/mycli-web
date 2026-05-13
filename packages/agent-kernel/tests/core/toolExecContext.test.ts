import { describe, it, expect } from 'vitest'
import { AgentSession } from '../../src/core/AgentSession'
import { ToolRegistry } from '../../src/core/ToolRegistry'
import type { ToolDefinition, ToolExecContext } from '../../src/core/types'
import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'

describe('ToolExecContext extension', () => {
  it('exposes optional turnId / callId / subagentId / emitSubagentEvent fields (type check)', () => {
    const ctx: ToolExecContext = {
      turnId: 't-1',
      callId: 'c-1',
      subagentId: 's-1' as any,
      emitSubagentEvent: () => {},
    }
    expect(ctx.turnId).toBe('t-1')
    expect(ctx.callId).toBe('c-1')
  })

  it('AgentSession populates ctx.callId from ToolCall.id when executing tools', async () => {
    let observedCtx: ToolExecContext | null = null
    const probe: ToolDefinition<{ x: number }, string> = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      async execute(_input, ctx) {
        observedCtx = ctx
        return { ok: true, data: 'ok' }
      },
    }
    const registry = new ToolRegistry()
    registry.register(probe)

    const llmClient: OpenAICompatibleClient = {
      async *streamChat() {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'call-XYZ', name: 'probe', input: { x: 1 } }],
        } as any
      },
    } as any

    const session = new AgentSession({
      llmClient,
      registry,
      toolContext: { turnId: 'turn-ABC' } as any,
    })

    const it = session.send('hi')
    for (let i = 0; i < 5; i++) {
      const next = await it.next()
      if (next.done) break
    }

    expect(observedCtx).not.toBeNull()
    expect((observedCtx as any).callId).toBe('call-XYZ')
    expect((observedCtx as any).turnId).toBe('turn-ABC')
  })
})
