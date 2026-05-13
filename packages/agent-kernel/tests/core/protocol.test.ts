import { describe, it, expect } from 'vitest'
import {
  ClientCmd,
  WireAgentEvent as AgentEvent,
  AgentEvent as CoreAgentEvent,
  Envelope,
} from 'agent-kernel'

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

describe('Core AgentEvent — approval/requested', () => {
  it('accepts approval/requested with all fields', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'approval/requested',
      approvalId: '33333333-3333-4333-8333-333333333333',
      tool: 'readPage',
      argsSummary: 'Read https://example.com',
      ctx: { origin: 'https://example.com', url: 'https://example.com/foo' },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts approval/requested with empty ctx', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'approval/requested',
      approvalId: '33333333-3333-4333-8333-333333333333',
      tool: 't',
      argsSummary: '',
      ctx: {},
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects approval/requested missing approvalId', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'approval/requested',
      tool: 't',
      argsSummary: '',
      ctx: {},
    })
    expect(parsed.success).toBe(false)
  })
})

describe('Core AgentEvent — todo/updated', () => {
  it('accepts todo/updated with full item shape', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'todo/updated',
      conversationId: 'conv-1',
      items: [
        {
          id: 't1',
          subject: 'Write tests',
          status: 'pending',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts todo/updated with empty items', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'todo/updated',
      conversationId: 'conv-1',
      items: [],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects todo/updated with invalid status', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'todo/updated',
      conversationId: 'conv-1',
      items: [
        {
          id: 't1',
          subject: 'x',
          status: 'archived',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('Wire AgentEvent — todo/updated', () => {
  it('accepts wire todo/updated with envelope + items', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'todo/updated',
      conversationId: '33333333-3333-4333-8333-333333333333',
      items: [
        {
          id: 't1',
          subject: 'A',
          status: 'in_progress',
          activeForm: 'Doing A',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts wire todo/updated with empty items', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'todo/updated',
      conversationId: '33333333-3333-4333-8333-333333333333',
      items: [],
    })
    expect(parsed.success).toBe(true)
  })
})
