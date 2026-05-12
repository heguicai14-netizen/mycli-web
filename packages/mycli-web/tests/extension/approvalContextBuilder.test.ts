import { describe, it, expect, vi } from 'vitest'

// We mock the kernel utility so this test is fast & deterministic.
vi.mock('agent-kernel', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    buildActiveTabApprovalContext: vi
      .fn()
      .mockResolvedValue({ origin: 'https://example.com', url: 'https://example.com/page' }),
  }
})

import { buildApprovalContext } from '@ext/approvalContextBuilder'

describe('buildApprovalContext', () => {
  it('returns kernel-utility result for non-selector tools', async () => {
    const ctx = await buildApprovalContext({ id: 'c1', name: 'readPage', input: {} })
    expect(ctx).toEqual({ origin: 'https://example.com', url: 'https://example.com/page' })
  })

  it('adds selector from args for querySelector-style tools', async () => {
    const ctx = await buildApprovalContext({
      id: 'c1',
      name: 'querySelector',
      input: { selector: '.btn' },
    })
    expect(ctx).toEqual({
      origin: 'https://example.com',
      url: 'https://example.com/page',
      selector: '.btn',
    })
  })

  it('does not add selector field if args.selector is not a string', async () => {
    const ctx = await buildApprovalContext({ id: 'c1', name: 'readPage', input: { selector: 42 } })
    expect('selector' in ctx).toBe(false)
  })
})
