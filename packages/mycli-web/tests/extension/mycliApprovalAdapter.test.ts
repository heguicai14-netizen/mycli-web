import { describe, it, expect, beforeEach } from 'vitest'
import { mycliApprovalAdapter } from '@ext/mycliApprovalAdapter'
import { addRule, listRules } from '@ext/storage/rules'

declare const chrome: any

beforeEach(async () => {
  // setup.ts wipes chrome.storage between tests — confirm by listing
  await chrome.storage.local.clear?.()
})

describe('mycliApprovalAdapter.check', () => {
  it('returns ask when no rule matches', async () => {
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: { origin: 'https://example.com' },
    })
    expect(res).toBe('ask')
  })

  it('returns allow when a matching origin rule exists', async () => {
    await addRule({
      tool: 'readPage',
      scope: { kind: 'origin', origin: 'https://example.com' },
      decision: 'allow',
    })
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: { origin: 'https://example.com' },
    })
    expect(res).toBe('allow')
  })

  it('returns deny when matching deny rule', async () => {
    await addRule({
      tool: 'readPage',
      scope: { kind: 'global' },
      decision: 'deny',
    })
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: {},
    })
    expect(res).toBe('deny')
  })

  it('different origin does not match', async () => {
    await addRule({
      tool: 'readPage',
      scope: { kind: 'origin', origin: 'https://example.com' },
      decision: 'allow',
    })
    const res = await mycliApprovalAdapter.check({
      tool: 'readPage',
      args: {},
      ctx: { origin: 'https://other.com' },
    })
    expect(res).toBe('ask')
  })
})

describe('mycliApprovalAdapter.recordRule', () => {
  it('writes an origin-scoped rule when ctx.origin is present', async () => {
    await mycliApprovalAdapter.recordRule!(
      { tool: 'readPage', args: {}, ctx: { origin: 'https://example.com' } },
      'allow',
    )
    const rules = await listRules()
    expect(rules).toHaveLength(1)
    expect(rules[0].tool).toBe('readPage')
    expect(rules[0].scope).toEqual({ kind: 'origin', origin: 'https://example.com' })
    expect(rules[0].decision).toBe('allow')
  })

  it('writes a global rule when ctx.origin is missing', async () => {
    await mycliApprovalAdapter.recordRule!(
      { tool: 'readPage', args: {}, ctx: {} },
      'allow',
    )
    const rules = await listRules()
    expect(rules[0].scope).toEqual({ kind: 'global' })
  })
})
