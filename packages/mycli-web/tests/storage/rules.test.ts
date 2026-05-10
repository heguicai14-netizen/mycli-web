import { describe, it, expect, beforeEach } from 'vitest'
import {
  addRule,
  listRules,
  removeRule,
  findMatchingRule,
} from '@ext/storage/rules'

describe('approval rules', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear()
  })

  it('addRule persists and listRules returns it', async () => {
    const r = await addRule({
      tool: 'click',
      scope: { kind: 'origin', origin: 'https://github.com' },
      decision: 'allow',
    })
    const list = await listRules()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(r.id)
  })

  it('removeRule deletes by id', async () => {
    const r = await addRule({ tool: 'click', scope: { kind: 'global' }, decision: 'allow' })
    await removeRule(r.id)
    expect((await listRules()).length).toBe(0)
  })

  it('expired rules are skipped by findMatchingRule', async () => {
    await addRule({
      tool: 'click',
      scope: { kind: 'global' },
      decision: 'allow',
      expiresAt: Date.now() - 1000,
    })
    const match = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.x' })
    expect(match).toBeUndefined()
  })

  it('findMatchingRule picks most specific match (originAndSelector > origin > global)', async () => {
    await addRule({ tool: 'click', scope: { kind: 'global' }, decision: 'allow' })
    await addRule({
      tool: 'click',
      scope: { kind: 'origin', origin: 'https://a.com' },
      decision: 'deny',
    })
    await addRule({
      tool: 'click',
      scope: { kind: 'originAndSelector', origin: 'https://a.com', selectorPattern: '.buy' },
      decision: 'allow',
    })
    const m = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.buy' })
    expect(m?.decision).toBe('allow')
    expect(m?.scope.kind).toBe('originAndSelector')

    const m2 = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.other' })
    expect(m2?.scope.kind).toBe('origin')
    expect(m2?.decision).toBe('deny')

    const m3 = await findMatchingRule({ tool: 'click', origin: 'https://b.com', selector: '.buy' })
    expect(m3?.scope.kind).toBe('global')
    expect(m3?.decision).toBe('allow')
  })

  it('rule tied to a different tool does not match', async () => {
    await addRule({ tool: 'type', scope: { kind: 'global' }, decision: 'allow' })
    const m = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.x' })
    expect(m).toBeUndefined()
  })
})
