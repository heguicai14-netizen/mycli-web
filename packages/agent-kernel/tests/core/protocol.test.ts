import { describe, it, expect } from 'vitest'
import { ClientCmd, WireAgentEvent as AgentEvent, Envelope } from 'agent-kernel'

describe('ClientCmd schema', () => {
  it('accepts chat/send with valid payload', () => {
    const parsed = ClientCmd.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'chat/send',
      text: 'hello',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects chat/send missing text', () => {
    const parsed = ClientCmd.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'chat/send',
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts approval/reply with decision once', () => {
    const parsed = ClientCmd.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'approval/reply',
      approvalId: '33333333-3333-4333-8333-333333333333',
      decision: 'once',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('AgentEvent schema', () => {
  it('accepts message/streamChunk', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'message/streamChunk',
      messageId: '44444444-4444-4444-8444-444444444444',
      delta: 'hello',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('Envelope', () => {
  it('wraps client → offscreen command', () => {
    const parsed = Envelope.safeParse({
      direction: 'client->offscreen',
      payload: {
        id: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        ts: 1_700_000_000_000,
        kind: 'chat/cancel',
      },
    })
    expect(parsed.success).toBe(true)
  })
})

describe('AgentEvent message/usage with cached', () => {
  it('accepts message/usage with cached field', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'message/usage',
      messageId: '44444444-4444-4444-8444-444444444444',
      input: 100,
      output: 20,
      cached: 80,
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts message/usage WITHOUT cached field (backward compat)', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'message/usage',
      messageId: '44444444-4444-4444-8444-444444444444',
      input: 100,
      output: 20,
    })
    expect(parsed.success).toBe(true)
  })
})
