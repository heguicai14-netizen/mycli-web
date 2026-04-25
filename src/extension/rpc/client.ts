import { ClientCmd, AgentEvent, Envelope } from './protocol'
import type { z } from 'zod'

type AnyCmd = z.infer<typeof ClientCmd>
type AnyEvt = z.infer<typeof AgentEvent>

type AckResult = { ok: true } | { ok: false; error: { code: string; message: string } }

export interface RpcClientOptions {
  portName: string
  sessionId?: string
  ackTimeoutMs?: number
  reconnect?: boolean
}

export class RpcClient {
  private port: chrome.runtime.Port | null = null
  private readonly portName: string
  public readonly sessionId: string
  private readonly ackTimeoutMs: number
  private reconnectEnabled: boolean
  private pendingAcks = new Map<string, { resolve: (r: AckResult) => void; timer: ReturnType<typeof setTimeout> }>()
  private handlers = new Map<AnyEvt['kind'], Set<(ev: AnyEvt) => void>>()
  private connected = false
  private retryDelay = 1000

  constructor(options: RpcClientOptions) {
    this.portName = options.portName
    this.sessionId = options.sessionId ?? crypto.randomUUID()
    this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000
    this.reconnectEnabled = options.reconnect ?? true
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      const p = chrome.runtime.connect({ name: this.portName })
      this.port = p
      this.connected = true
      // Reset backoff on every successful (re)connect so the next disconnect retries
      // quickly instead of inheriting a long delay from prior outages.
      this.retryDelay = 1000
      p.onMessage.addListener((raw) => this._onMessage(raw))
      p.onDisconnect.addListener(() => this._onDisconnect())
      queueMicrotask(() => resolve())
    })
  }

  private _onMessage(raw: unknown) {
    const parsed = AgentEvent.safeParse(raw)
    if (!parsed.success) return
    const ev = parsed.data
    if (ev.kind === 'command/ack') {
      const p = this.pendingAcks.get(ev.correlationId)
      if (p) {
        clearTimeout(p.timer)
        this.pendingAcks.delete(ev.correlationId)
        if (ev.ok) p.resolve({ ok: true })
        else p.resolve({ ok: false, error: ev.error ?? { code: 'unknown', message: '' } })
      }
      return
    }
    const set = this.handlers.get(ev.kind)
    if (set) for (const h of set) h(ev)
  }

  private _onDisconnect() {
    this.connected = false
    this.port = null
    for (const [, p] of this.pendingAcks) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: { code: 'port_closed', message: 'Port disconnected before ack' } })
    }
    this.pendingAcks.clear()
    if (this.reconnectEnabled) {
      setTimeout(() => this.connect().catch(() => {}), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
    }
  }

  disconnect() {
    this.reconnectEnabled = false
    this.port?.disconnect()
  }

  async send(partial: Omit<AnyCmd, 'id' | 'sessionId' | 'ts'>): Promise<AckResult> {
    const full = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      ts: Date.now(),
      ...partial,
    } as AnyCmd
    return this.sendRaw(full)
  }

  async sendRaw(cmd: unknown): Promise<AckResult> {
    if (!this.port) throw new Error('not connected')
    const id = (cmd as any)?.id ?? crypto.randomUUID()
    return new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id)
        resolve({ ok: false, error: { code: 'ack_timeout', message: `no ack within ${this.ackTimeoutMs}ms` } })
      }, this.ackTimeoutMs)
      this.pendingAcks.set(id, { resolve, timer })
      // Register pendingAck before posting — the in-memory mock delivers synchronously,
      // so if we post first the ack arrives before we've registered the handler.
      this.port!.postMessage(cmd)
    })
  }

  on<K extends AnyEvt['kind']>(kind: K, handler: (ev: Extract<AnyEvt, { kind: K }>) => void) {
    if (!this.handlers.has(kind)) this.handlers.set(kind, new Set())
    this.handlers.get(kind)!.add(handler as any)
  }

  off<K extends AnyEvt['kind']>(kind: K, handler: (ev: Extract<AnyEvt, { kind: K }>) => void) {
    this.handlers.get(kind)?.delete(handler as any)
  }
}

export { Envelope }
