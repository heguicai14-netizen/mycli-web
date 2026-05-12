export type ApprovalDecision = 'allow' | 'deny' | 'ask'
export type ApprovalReplyDecision = 'once' | 'session' | 'always' | 'deny'

export interface ApprovalContext {
  [k: string]: unknown
}

export interface ApprovalRequest {
  tool: string
  args: unknown
  ctx: ApprovalContext
}

export interface ApprovalAdapter {
  check(req: ApprovalRequest): Promise<ApprovalDecision>
  recordRule?(req: ApprovalRequest, decision: 'allow' | 'deny'): Promise<void>
}

type Deferred = {
  resolve: (v: 'allow' | 'deny') => void
  reject: (e: unknown) => void
  sessionId: string
  req: ApprovalRequest
}

export class ApprovalCoordinator {
  private pending = new Map<string, Deferred>()
  private sticky = new Map<string, 'allow'>()

  constructor(
    private opts: {
      adapter: ApprovalAdapter
      emit: (e: { approvalId: string; req: ApprovalRequest; summary: string }) => void
    },
  ) {}

  async gate(
    req: ApprovalRequest,
    summary: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<'allow' | 'deny'> {
    const stickyKey = this.stickyKey(sessionId, req.tool, req.args)
    if (this.sticky.has(stickyKey)) return 'allow'

    let decision: ApprovalDecision
    try {
      decision = await this.opts.adapter.check(req)
    } catch (e) {
      console.warn('[ApprovalCoordinator] adapter.check threw, degrading to ask', e)
      decision = 'ask'
    }
    if (decision === 'allow' || decision === 'deny') return decision

    const approvalId = crypto.randomUUID()
    const promise = new Promise<'allow' | 'deny'>((resolve, reject) => {
      this.pending.set(approvalId, { resolve, reject, sessionId, req })
    })
    if (signal) {
      if (signal.aborted) {
        this.pending.delete(approvalId)
        throw signal.reason ?? new Error('aborted')
      }
      signal.addEventListener(
        'abort',
        () => {
          const d = this.pending.get(approvalId)
          if (d) {
            this.pending.delete(approvalId)
            d.reject(signal.reason ?? new Error('aborted'))
          }
        },
        { once: true },
      )
    }
    this.opts.emit({ approvalId, req, summary })
    return promise
  }

  resolve(approvalId: string, reply: ApprovalReplyDecision): void {
    const d = this.pending.get(approvalId)
    if (!d) {
      console.warn('[ApprovalCoordinator] resolve called with unknown approvalId', approvalId)
      return
    }
    this.pending.delete(approvalId)
    if (reply === 'deny') {
      d.resolve('deny')
      return
    }
    if (reply === 'once') {
      d.resolve('allow')
      return
    }
    if (reply === 'session') {
      this.sticky.set(this.stickyKey(d.sessionId, d.req.tool, d.req.args), 'allow')
      d.resolve('allow')
      return
    }
    if (this.opts.adapter.recordRule) {
      this.opts.adapter.recordRule(d.req, 'allow').catch((e) => {
        console.warn('[ApprovalCoordinator] adapter.recordRule failed', e)
      })
      this.sticky.set(this.stickyKey(d.sessionId, d.req.tool, d.req.args), 'allow')
    } else {
      console.warn(
        '[ApprovalCoordinator] reply=always but adapter has no recordRule — degrading to session',
      )
      this.sticky.set(this.stickyKey(d.sessionId, d.req.tool, d.req.args), 'allow')
    }
    d.resolve('allow')
  }

  cancelSession(sessionId: string, reason: string): void {
    for (const [id, d] of this.pending) {
      if (d.sessionId === sessionId) {
        this.pending.delete(id)
        d.reject(new Error(reason))
      }
    }
  }

  private stickyKey(sessionId: string, tool: string, args: unknown): string {
    return `${sessionId} ${tool} ${this.fingerprint(args)}`
  }

  private fingerprint(args: unknown): string {
    try {
      return JSON.stringify(args)
    } catch {
      return String(args)
    }
  }
}
