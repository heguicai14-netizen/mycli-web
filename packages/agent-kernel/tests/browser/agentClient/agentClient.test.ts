import { describe, it, expect } from 'vitest'
import { installHub, createAgentClient } from 'agent-kernel'

// Stand up a minimal "fake offscreen" that replies to a chat/send the same
// way the real offscreen does — emits a message/streamChunk, then a final
// message/appended with role=assistant pending=false. Lets us drive the SDK
// end-to-end through the real hub + RpcClient without booting offscreen.ts.
function startFakeOffscreen(opts: {
  reply: string
  toolCalls?: Array<{ tool: string; args: unknown; ok: boolean }>
  onCmd?: (cmd: any) => void
}) {
  return new Promise<void>((resolve) => {
    chrome.runtime.onConnect.addListener((p) => {
      if (p.name !== 'sw-to-offscreen') return
      p.onMessage.addListener((rawCmd: any) => {
        opts.onCmd?.(rawCmd)
        if (rawCmd?.kind !== 'chat/send') return
        // Optional tool calls in the middle of the turn.
        for (const tc of opts.toolCalls ?? []) {
          const id = crypto.randomUUID()
          p.postMessage({
            id: crypto.randomUUID(),
            sessionId: rawCmd.sessionId,
            ts: Date.now(),
            kind: 'tool/start',
            toolCall: { id, tool: tc.tool, args: tc.args },
          })
          p.postMessage({
            id: crypto.randomUUID(),
            sessionId: rawCmd.sessionId,
            ts: Date.now(),
            kind: 'tool/end',
            toolCallId: id,
            result: { ok: tc.ok },
          })
        }
        // Stream chunk + terminal assistant.
        const messageId = crypto.randomUUID()
        p.postMessage({
          id: crypto.randomUUID(),
          sessionId: rawCmd.sessionId,
          ts: Date.now(),
          kind: 'message/streamChunk',
          messageId,
          delta: opts.reply,
        })
        p.postMessage({
          id: crypto.randomUUID(),
          sessionId: rawCmd.sessionId,
          ts: Date.now(),
          kind: 'message/appended',
          message: {
            id: messageId,
            role: 'assistant',
            content: opts.reply,
            createdAt: Date.now(),
            pending: false,
          },
        })
      })
      resolve()
    })
  })
}

describe('AgentClient.message', () => {
  it('streams events and terminates on terminal assistant message', async () => {
    installHub({ mode: 'offscreen-forward' })
    void startFakeOffscreen({ reply: 'hello world' })

    const agent = createAgentClient({ reconnect: false })
    const events: any[] = []
    for await (const ev of agent.message({ text: 'hi' })) {
      events.push(ev)
    }
    agent.close()

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('message/streamChunk')
    expect(kinds).toContain('message/appended')
    // Last event must be the terminal assistant pending=false.
    const last = events[events.length - 1]
    expect(last.kind).toBe('message/appended')
    expect(last.message.role).toBe('assistant')
    expect(last.message.pending).toBe(false)
  })
})

describe('AgentClient.oneShot', () => {
  it('returns final text and forwards override fields', async () => {
    installHub({ mode: 'offscreen-forward' })
    let receivedCmd: any
    void startFakeOffscreen({
      reply: 'final answer',
      onCmd: (cmd) => {
        receivedCmd = cmd
      },
    })

    const agent = createAgentClient({ reconnect: false })
    const result = await agent.oneShot('explain x', {
      system: 'one sentence',
      tools: ['readPage'],
      model: 'gpt-test',
    })
    agent.close()

    expect(result.text).toBe('final answer')
    expect(receivedCmd.text).toBe('explain x')
    expect(receivedCmd.system).toBe('one sentence')
    expect(receivedCmd.tools).toEqual(['readPage'])
    expect(receivedCmd.model).toBe('gpt-test')
    // oneShot defaults to ephemeral=true.
    expect(receivedCmd.ephemeral).toBe(true)
  })

  it('captures tool calls in the result', async () => {
    installHub({ mode: 'offscreen-forward' })
    void startFakeOffscreen({
      reply: 'done',
      toolCalls: [
        { tool: 'readPage', args: { mode: 'text' }, ok: true },
        { tool: 'querySelector', args: { selector: '#x' }, ok: false },
      ],
    })

    const agent = createAgentClient({ reconnect: false })
    const result = await agent.oneShot('do stuff')
    agent.close()

    expect(result.text).toBe('done')
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].tool).toBe('readPage')
    expect(result.toolCalls[0].ok).toBe(true)
    expect(result.toolCalls[1].tool).toBe('querySelector')
    expect(result.toolCalls[1].ok).toBe(false)
  })

  it('omits ephemeral=false override when not requested by caller', async () => {
    installHub({ mode: 'offscreen-forward' })
    let receivedCmd: any
    void startFakeOffscreen({
      reply: 'ok',
      onCmd: (cmd) => {
        receivedCmd = cmd
      },
    })

    const agent = createAgentClient({ reconnect: false })
    // Caller explicitly opts into persistence.
    await agent.oneShot('hello', { ephemeral: false })
    agent.close()

    expect(receivedCmd.ephemeral).toBe(false)
  })
})
