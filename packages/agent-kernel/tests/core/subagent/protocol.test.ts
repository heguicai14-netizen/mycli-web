import { describe, it, expect } from 'vitest'
import { AgentEvent } from '../../../src/core/protocol'

describe('AgentEvent subagent/* variants', () => {
  it('parses subagent/started', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/started',
      subagentId: 's-1',
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      subagentType: 'general-purpose',
      description: 'do thing',
      prompt: 'go',
      startedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/message with text', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/message',
      subagentId: 's-1',
      text: 'hi',
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_call', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/tool_call',
      subagentId: 's-1',
      callId: 'c-2',
      toolName: 'readPage',
      args: { url: 'x' },
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_end (ok)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/tool_end',
      subagentId: 's-1',
      callId: 'c-2',
      ok: true,
      content: 'result',
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_end (error)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/tool_end',
      subagentId: 's-1',
      callId: 'c-2',
      ok: false,
      error: { code: 'x', message: 'y' },
      ts: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/finished (success)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/finished',
      subagentId: 's-1',
      ok: true,
      text: 'final',
      iterations: 3,
      finishedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/finished (failure)', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/finished',
      subagentId: 's-1',
      ok: false,
      error: { code: 'aborted', message: '...' },
      iterations: 2,
      finishedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('rejects subagent/finished missing iterations', () => {
    const r = AgentEvent.safeParse({
      kind: 'subagent/finished',
      subagentId: 's-1',
      ok: true,
      text: 'x',
      finishedAt: 1,
    })
    expect(r.success).toBe(false)
  })
})
