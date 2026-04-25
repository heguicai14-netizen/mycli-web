import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import {
  appendAudit,
  listAuditByConversation,
  listAuditByTimeRange,
  pruneAuditOlderThan,
} from '@ext/storage/auditLog'

describe('auditLog store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('appendAudit stores entry with auto id', async () => {
    const row = await appendAudit({
      conversationId: 'c1',
      tool: 'readPage',
      argsSummary: '{}',
      resultSummary: 'ok',
      outcome: 'ok',
    })
    expect(row.id).toMatch(/[0-9a-f-]{36}/i)
    expect(row.ts).toBeGreaterThan(0)
  })

  it('listAuditByConversation filters by conversation', async () => {
    await appendAudit({ conversationId: 'c1', tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await appendAudit({ conversationId: 'c2', tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    expect((await listAuditByConversation('c1')).length).toBe(1)
    expect((await listAuditByConversation('c2')).length).toBe(1)
  })

  it('listAuditByTimeRange filters by ts', async () => {
    const a = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await new Promise((r) => setTimeout(r, 2))
    const b = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    const range = await listAuditByTimeRange(a.ts, b.ts)
    expect(range.length).toBe(2)
  })

  it('pruneAuditOlderThan removes rows with ts < cutoff', async () => {
    const old = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await new Promise((r) => setTimeout(r, 5))
    const cutoff = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    const fresh = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await pruneAuditOlderThan(cutoff)
    const all = await listAuditByTimeRange(0, Date.now() + 1000)
    expect(all.map((r) => r.id)).toEqual([fresh.id])
  })
})
