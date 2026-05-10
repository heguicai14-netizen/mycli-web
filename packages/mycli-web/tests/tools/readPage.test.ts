import { describe, it, expect, vi } from 'vitest'
import { readPageTool } from '@ext-tools/tools/readPage'
import type { ExtensionToolCtx } from '@ext-tools/ctx'
import type { ToolExecContext } from 'agent-kernel'

type ReadPageCtx = ToolExecContext & ExtensionToolCtx

function makeCtx(overrides: Partial<ReadPageCtx> = {}): ReadPageCtx {
  return {
    tabId: 42,
    rpc: {
      domOp: vi.fn().mockResolvedValue({ ok: true, data: { text: 'hello world' } }),
      chromeApi: vi.fn(),
    },
    conversationId: 'conv1',
    ...overrides,
  }
}

describe('readPage tool', () => {
  it('returns ok with page text', async () => {
    const ctx = makeCtx()
    const result = await readPageTool.execute({ mode: 'text' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.text).toBe('hello world')
    expect(ctx.rpc.domOp).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dom/readPage', tabId: 42, mode: 'text' }),
      expect.any(Number),
    )
  })

  it('errors when no tabId in context', async () => {
    const ctx = makeCtx({ tabId: undefined })
    const result = await readPageTool.execute({ mode: 'text' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('no_active_tab')
  })

  it('defaults mode to text when not provided', async () => {
    const ctx = makeCtx()
    await readPageTool.execute({}, ctx)
    expect(ctx.rpc.domOp).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'text' }),
      expect.any(Number),
    )
  })
})
