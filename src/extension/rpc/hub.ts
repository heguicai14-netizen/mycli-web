import { ClientCmd, AgentEvent } from './protocol'

export interface HubOptions {
  mode: 'echo' | 'offscreen-forward'
}

export function installHub(options: HubOptions = { mode: 'echo' }) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'session') return
    port.onMessage.addListener((raw) => {
      const parsed = ClientCmd.safeParse(raw)
      if (!parsed.success) {
        port.postMessage(ackError((raw as any)?.id, 'schema_invalid', parsed.error.message))
        return
      }
      const cmd = parsed.data
      port.postMessage(ack(cmd.id, cmd.sessionId))
      if (options.mode === 'echo' && cmd.kind === 'ping') {
        queueMicrotask(() => {
          const pong: AgentEvent = {
            id: crypto.randomUUID(),
            sessionId: cmd.sessionId,
            ts: Date.now(),
            kind: 'pong',
          }
          port.postMessage(pong)
        })
      }
    })
  })
}

function ack(correlationId: string, sessionId: string): AgentEvent {
  return {
    id: crypto.randomUUID(),
    sessionId,
    ts: Date.now(),
    kind: 'command/ack',
    correlationId,
    ok: true,
  }
}

function ackError(correlationId: string | undefined, code: string, message: string): AgentEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: '00000000-0000-4000-8000-000000000000',
    ts: Date.now(),
    kind: 'command/ack',
    correlationId: correlationId ?? '00000000-0000-4000-8000-000000000000',
    ok: false,
    error: { code, message },
  }
}
