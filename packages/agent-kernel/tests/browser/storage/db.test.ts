import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, DB_NAME, DB_VERSION, resetDbForTests } from 'agent-kernel'

describe('openDb', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('creates all required object stores on first open', async () => {
    const db = await openDb()
    const names = Array.from(db.objectStoreNames).sort()
    expect(names).toEqual(['auditLog', 'conversations', 'messages', 'skillData', 'skills'].sort())
    db.close()
  })

  it('returns a connection at DB_VERSION', async () => {
    const db = await openDb()
    expect(db.version).toBe(DB_VERSION)
    db.close()
  })

  it('is idempotent — reopening returns the same schema', async () => {
    const db1 = await openDb()
    db1.close()
    const db2 = await openDb()
    expect(Array.from(db2.objectStoreNames).sort()).toEqual(
      ['auditLog', 'conversations', 'messages', 'skillData', 'skills'].sort(),
    )
    db2.close()
  })

  it('DB_NAME is agent-kernel', () => {
    expect(DB_NAME).toBe('agent-kernel')
  })
})
