import { describe, it, expect } from 'vitest'
import { AgentEvent } from '../../../src/browser/rpc/protocol'

const envelope = {
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  ts: 1,
}

describe('wire AgentEvent — subagent/* variants', () => {
  it('parses subagent/started', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/started',
      subagentId: 'sid',
      parentTurnId: 't',
      parentCallId: 'c',
      subagentType: 'gp',
      description: 'd',
      prompt: 'p',
      startedAt: 1,
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/message', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/message',
      subagentId: 'sid',
      text: 'hi',
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_call', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/tool_call',
      subagentId: 'sid',
      callId: 'c2',
      toolName: 'readPage',
      args: {},
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/tool_end', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/tool_end',
      subagentId: 'sid',
      callId: 'c2',
      ok: true,
      content: 'r',
    })
    expect(r.success).toBe(true)
  })

  it('parses subagent/finished', () => {
    const r = AgentEvent.safeParse({
      ...envelope,
      kind: 'subagent/finished',
      subagentId: 'sid',
      ok: true,
      text: 'fin',
      iterations: 1,
      finishedAt: 2,
    })
    expect(r.success).toBe(true)
  })
})
