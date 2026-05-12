import { describe, it, expect, vi } from 'vitest'
import { ApprovalCoordinator, type ApprovalAdapter } from 'agent-kernel'

const stubAdapter = (overrides: Partial<ApprovalAdapter> = {}): ApprovalAdapter => ({
  check: vi.fn().mockResolvedValue('ask'),
  recordRule: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

const makeCoord = (opts: { adapter?: ApprovalAdapter; emit?: any } = {}) => {
  const adapter = opts.adapter ?? stubAdapter()
  const emit = opts.emit ?? vi.fn()
  const coord = new ApprovalCoordinator({ adapter, emit })
  return { coord, adapter, emit }
}

describe('ApprovalCoordinator.gate', () => {
  it('returns allow when adapter says allow', async () => {
    const { coord } = makeCoord({ adapter: stubAdapter({ check: vi.fn().mockResolvedValue('allow') }) })
    const res = await coord.gate({ tool: 't', args: {}, ctx: {} }, 'sum', 's1')
    expect(res).toBe('allow')
  })

  it('returns deny when adapter says deny', async () => {
    const { coord } = makeCoord({ adapter: stubAdapter({ check: vi.fn().mockResolvedValue('deny') }) })
    const res = await coord.gate({ tool: 't', args: {}, ctx: {} }, 'sum', 's1')
    expect(res).toBe('deny')
  })

  it('emits approval_requested when adapter says ask, then resolves on reply=once → allow', async () => {
    const { coord, emit } = makeCoord()
    const p = coord.gate({ tool: 't', args: { a: 1 }, ctx: {} }, 'do thing', 's1')
    await new Promise((r) => setTimeout(r, 0))
    expect(emit).toHaveBeenCalledTimes(1)
    const arg = (emit as any).mock.calls[0][0]
    expect(arg.approvalId).toBeTypeOf('string')
    expect(arg.summary).toBe('do thing')
    expect(arg.req.tool).toBe('t')
    coord.resolve(arg.approvalId, 'once')
    expect(await p).toBe('allow')
  })

  it('reply=deny resolves to deny', async () => {
    const { coord, emit } = makeCoord()
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 's1')
    await new Promise((r) => setTimeout(r, 0))
    const id = (emit as any).mock.calls[0][0].approvalId
    coord.resolve(id, 'deny')
    expect(await p).toBe('deny')
  })

  it('reply=session adds sticky so subsequent gate returns allow without re-asking', async () => {
    const { coord, adapter, emit } = makeCoord()
    const p1 = coord.gate({ tool: 't', args: { x: 1 }, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'session')
    expect(await p1).toBe('allow')
    expect((adapter.check as any)).toHaveBeenCalledTimes(1)
    const p2 = coord.gate({ tool: 't', args: { x: 1 }, ctx: {} }, 's', 'sess')
    expect(await p2).toBe('allow')
    expect((adapter.check as any)).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('sticky scoped per sessionId — different session re-asks', async () => {
    const { coord, adapter, emit } = makeCoord()
    const p1 = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'A')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'session')
    await p1
    const p2 = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'B')
    await new Promise((r) => setTimeout(r, 0))
    expect((adapter.check as any)).toHaveBeenCalledTimes(2)
    coord.resolve((emit as any).mock.calls[1][0].approvalId, 'once')
    await p2
  })

  it('reply=always calls adapter.recordRule and stickys for session', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const { coord, emit } = makeCoord({
      adapter: stubAdapter({ check: vi.fn().mockResolvedValue('ask'), recordRule: record }),
    })
    const p = coord.gate({ tool: 't', args: { a: 1 }, ctx: { origin: 'x' } }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'always')
    expect(await p).toBe('allow')
    expect(record).toHaveBeenCalledWith(
      { tool: 't', args: { a: 1 }, ctx: { origin: 'x' } },
      'allow',
    )
  })

  it('reply=always with no recordRule warns and degrades to session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { coord, emit } = makeCoord({
      adapter: { check: vi.fn().mockResolvedValue('ask') },
    })
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'always')
    expect(await p).toBe('allow')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('adapter.check throwing degrades to ask (safe default)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { coord, emit } = makeCoord({
      adapter: stubAdapter({ check: vi.fn().mockRejectedValue(new Error('boom')) }),
    })
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    expect(emit).toHaveBeenCalledTimes(1)
    coord.resolve((emit as any).mock.calls[0][0].approvalId, 'once')
    expect(await p).toBe('allow')
    warn.mockRestore()
  })

  it('cancelSession rejects pending promises for that session', async () => {
    const { coord, emit } = makeCoord()
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess')
    await new Promise((r) => setTimeout(r, 0))
    expect(emit).toHaveBeenCalledTimes(1)
    coord.cancelSession('sess', 'abort')
    await expect(p).rejects.toThrow(/abort/)
  })

  it('resolve with unknown approvalId is silently ignored (warn only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { coord } = makeCoord()
    coord.resolve('does-not-exist', 'once')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('AbortSignal aborts pending gate', async () => {
    const { coord } = makeCoord()
    const ac = new AbortController()
    const p = coord.gate({ tool: 't', args: {}, ctx: {} }, 's', 'sess', ac.signal)
    await new Promise((r) => setTimeout(r, 0))
    ac.abort(new Error('user cancel'))
    await expect(p).rejects.toThrow(/cancel/)
  })
})
