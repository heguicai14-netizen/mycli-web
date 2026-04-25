import { ClientCmd, AgentEvent } from './protocol'

export interface HubOptions {
  mode: 'echo' | 'offscreen-forward'
  /** Used in tests to override the SW-to-offscreen port name */
  offscreenPortName?: string
}

const DEFAULT_OFFSCREEN_PORT = 'sw-to-offscreen'
const UNKNOWN_SESSION_ID = '00000000-0000-4000-8000-000000000000'

interface Session {
  port: chrome.runtime.Port
  sessionId: string
}

export function installHub(options: HubOptions = { mode: 'echo' }) {
  const offscreenPortName = options.offscreenPortName ?? DEFAULT_OFFSCREEN_PORT
  const sessionsByPort = new Map<chrome.runtime.Port, Session>()
  const sessionsById = new Map<string, Session>()
  let offscreenPort: chrome.runtime.Port | null = null
  const offscreenPendingMessages: unknown[] = []

  function ensureOffscreenPort() {
    if (offscreenPort) return
    if (options.mode !== 'offscreen-forward') return
    try {
      offscreenPort = chrome.runtime.connect({ name: offscreenPortName })
      offscreenPort.onMessage.addListener((raw) => routeAgentEventToClient(raw))
      offscreenPort.onDisconnect.addListener(() => {
        offscreenPort = null
      })
      while (offscreenPendingMessages.length) {
        offscreenPort.postMessage(offscreenPendingMessages.shift())
      }
    } catch {
      // No offscreen runtime listening yet — retry on next message
    }
  }

  function routeAgentEventToClient(raw: unknown) {
    const parsed = AgentEvent.safeParse(raw)
    if (!parsed.success) return
    const ev = parsed.data
    const session = sessionsById.get(ev.sessionId)
    if (session) session.port.postMessage(ev)
  }

  function forwardClientCmdToOffscreen(cmd: unknown) {
    if (!offscreenPort) {
      offscreenPendingMessages.push(cmd)
      ensureOffscreenPort()
      return
    }
    offscreenPort.postMessage(cmd)
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'session') return
    const session: Session = { port, sessionId: '' }
    sessionsByPort.set(port, session)

    port.onMessage.addListener((raw) => {
      const parsed = ClientCmd.safeParse(raw)
      if (!parsed.success) {
        port.postMessage(ackError((raw as any)?.id, 'schema_invalid', parsed.error.message))
        return
      }
      const cmd = parsed.data
      if (!session.sessionId) {
        session.sessionId = cmd.sessionId
        sessionsById.set(cmd.sessionId, session)
      }
      port.postMessage(ack(cmd.id, cmd.sessionId))

      if (options.mode === 'echo' && cmd.kind === 'ping') {
        // Defer pong by a microtask so test handlers attached after `await send()`
        // get a chance to be registered before the event arrives.
        queueMicrotask(() => {
          const pong: AgentEvent = {
            id: crypto.randomUUID(),
            sessionId: cmd.sessionId,
            ts: Date.now(),
            kind: 'pong',
          }
          port.postMessage(pong)
        })
      } else if (options.mode === 'offscreen-forward') {
        ensureOffscreenPort()
        forwardClientCmdToOffscreen(cmd)
      }
    })

    port.onDisconnect.addListener(() => {
      sessionsByPort.delete(port)
      if (session.sessionId) sessionsById.delete(session.sessionId)
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
    sessionId: UNKNOWN_SESSION_ID,
    ts: Date.now(),
    kind: 'command/ack',
    correlationId: correlationId ?? UNKNOWN_SESSION_ID,
    ok: false,
    error: { code, message },
  }
}
