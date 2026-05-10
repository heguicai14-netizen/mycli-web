// AgentClient SDK — call the in-extension agent from any consumer (chat
// window, right-click menu, options page test button, background alarm…)
// without re-implementing the RpcClient + event-handler dance.
//
// Usage:
//   const agent = createAgentClient()
//   for await (const ev of agent.message({ text: 'hi' })) { ... }
//   const { text } = await agent.oneShot('summarize this page', {
//     tools: ['readPage'],
//     system: 'one sentence only',
//   })
//   agent.close()
//
// One AgentClient owns one port (= one sessionId). Calls on a single client
// are serial — start a new turn only after the previous AsyncIterable has
// drained or oneShot has resolved. For parallel work, create more clients.

import { RpcClient } from '../rpc/client'
import type { AgentEvent } from '../rpc/protocol'

export interface MessageOptions {
  text: string
  /** Override the default system prompt. */
  system?: string
  /** Allowlist of tool names (e.g. `['readPage']`). Undefined = all tools. */
  tools?: string[]
  /** Override the LLM model id. */
  model?: string
  /** Skip IndexedDB persistence and history. Default false. */
  ephemeral?: boolean
}

export interface OneShotOptions extends Omit<MessageOptions, 'text'> {
  /** Aborts the in-flight turn when fired. */
  signal?: AbortSignal
}

export interface OneShotToolCall {
  id: string
  tool: string
  args: unknown
  result?: unknown
  ok: boolean
}

export interface OneShotResult {
  text: string
  toolCalls: OneShotToolCall[]
}

export interface CreateAgentClientOptions {
  /** Pin to a specific sessionId (e.g. resume an existing conversation). */
  sessionId?: string
  /** Auto-reconnect on port disconnect. Default true. */
  reconnect?: boolean
  /** Send a no-op `ping` every N ms once connected to keep the MV3 SW warm.
   *  Default 25_000. Set to 0 to disable. The hub acks pings unconditionally,
   *  so this is a free turn that never reaches the offscreen agent loop. */
  heartbeatMs?: number
}

export interface AgentClient {
  /** Stream raw AgentEvents for one turn. Iterator ends on terminal assistant
   *  message; throws on fatalError. */
  message(opts: MessageOptions): AsyncIterable<AgentEvent>
  /** Run one turn, return the final assistant text and any tool calls. Defaults
   *  to ephemeral mode (does not pollute conversation history). */
  oneShot(text: string, opts?: OneShotOptions): Promise<OneShotResult>
  /** Abort the in-flight turn. No-op if nothing is running. */
  cancel(): void
  /** Tear down the underlying port. The client is unusable after this. */
  close(): void
  /** Underlying sessionId (read for diagnostics). */
  readonly sessionId: string
}

export function createAgentClient(opts: CreateAgentClientOptions = {}): AgentClient {
  const rpc = new RpcClient({
    portName: 'session',
    sessionId: opts.sessionId,
    reconnect: opts.reconnect ?? true,
  })
  let connected = false
  const heartbeatMs = opts.heartbeatMs ?? 25_000
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  async function ensureConnected(): Promise<void> {
    if (connected) return
    await rpc.connect()
    connected = true
    if (heartbeatMs > 0 && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        rpc.send({ kind: 'ping' as any }).catch(() => {})
      }, heartbeatMs)
    }
  }

  function message(msgOpts: MessageOptions): AsyncIterable<AgentEvent> {
    const buffer: AgentEvent[] = []
    const waiters: Array<(r: IteratorResult<AgentEvent>) => void> = []
    let finished = false
    let errVal: Error | undefined
    let detachers: Array<() => void> = []

    function push(ev: AgentEvent) {
      if (finished) return
      const w = waiters.shift()
      if (w) w({ value: ev, done: false })
      else buffer.push(ev)
    }
    function close(err?: Error) {
      if (finished) return
      finished = true
      if (err) errVal = err
      for (const d of detachers) d()
      detachers = []
      while (waiters.length) waiters.shift()!({ value: undefined as never, done: true })
    }

    void (async () => {
      try {
        await ensureConnected()

        const onMsgAppended = (ev: any) => {
          push(ev)
          // Terminal signal: the offscreen sends a final message/appended for
          // the assistant message with pending=false when the turn is done.
          if (ev.message?.role === 'assistant' && ev.message?.pending === false) {
            close()
          }
        }
        const onSimple = (ev: any) => push(ev)
        const onFatal = (ev: any) => {
          push(ev)
          close(new Error(`${ev.code}: ${ev.message}`))
        }

        rpc.on('message/appended', onMsgAppended)
        rpc.on('message/streamChunk', onSimple)
        rpc.on('tool/start', onSimple)
        rpc.on('tool/end', onSimple)
        rpc.on('fatalError', onFatal)
        detachers = [
          () => rpc.off('message/appended', onMsgAppended),
          () => rpc.off('message/streamChunk', onSimple),
          () => rpc.off('tool/start', onSimple),
          () => rpc.off('tool/end', onSimple),
          () => rpc.off('fatalError', onFatal),
        ]

        const ack = await rpc.send({
          kind: 'chat/send',
          text: msgOpts.text,
          ...(msgOpts.system !== undefined && { system: msgOpts.system }),
          ...(msgOpts.tools !== undefined && { tools: msgOpts.tools }),
          ...(msgOpts.model !== undefined && { model: msgOpts.model }),
          ...(msgOpts.ephemeral !== undefined && { ephemeral: msgOpts.ephemeral }),
        })
        if (!ack.ok) {
          close(new Error(`ack failed: ${ack.error.code}: ${ack.error.message}`))
        }
      } catch (e) {
        close(e instanceof Error ? e : new Error(String(e)))
      }
    })()

    const iter: AsyncIterableIterator<AgentEvent> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next(): Promise<IteratorResult<AgentEvent>> {
        if (errVal) {
          const err = errVal
          errVal = undefined
          return Promise.reject(err)
        }
        if (buffer.length)
          return Promise.resolve({ value: buffer.shift()!, done: false })
        if (finished)
          return Promise.resolve({ value: undefined as never, done: true })
        return new Promise<IteratorResult<AgentEvent>>((resolve) =>
          waiters.push(resolve),
        )
      },
      return() {
        close()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
    return iter
  }

  async function oneShot(
    text: string,
    opts: OneShotOptions = {},
  ): Promise<OneShotResult> {
    let assistantText = ''
    const toolCalls: OneShotToolCall[] = []
    const stream = message({
      text,
      system: opts.system,
      tools: opts.tools,
      model: opts.model,
      // Default ephemeral=true for oneShot — caller didn't ask for persistence.
      ephemeral: opts.ephemeral ?? true,
    })

    const onAbort = () => {
      rpc.send({ kind: 'chat/cancel' }).catch(() => {})
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for await (const ev of stream) {
        if (opts.signal?.aborted) throw new Error('aborted')
        if (ev.kind === 'message/streamChunk') {
          assistantText += ev.delta
        } else if (
          ev.kind === 'message/appended' &&
          (ev as any).message.role === 'assistant' &&
          (ev as any).message.pending === false
        ) {
          // Terminal — overrides any partially-streamed text in case the
          // server reformatted it on finalization.
          assistantText = (ev as any).message.content
        } else if (ev.kind === 'tool/start') {
          toolCalls.push({
            id: ev.toolCall.id,
            tool: ev.toolCall.tool,
            args: ev.toolCall.args,
            ok: false,
          })
        } else if (ev.kind === 'tool/end') {
          const tc = toolCalls.find((t) => t.id === ev.toolCallId)
          if (tc) {
            tc.result = ev.result
            tc.ok = (ev.result as any).ok ?? false
          }
        }
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
    return { text: assistantText, toolCalls }
  }

  function cancel() {
    if (connected) rpc.send({ kind: 'chat/cancel' }).catch(() => {})
  }

  function close() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    rpc.disconnect()
    connected = false
  }

  return {
    message,
    oneShot,
    cancel,
    close,
    get sessionId() {
      return rpc.sessionId
    },
  }
}
