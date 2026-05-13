import { describe, it, expect, beforeEach, vi } from 'vitest'
import { bootKernelOffscreen } from '../../src/browser/bootKernelOffscreen'
import type { SubagentType } from '../../src/core/subagent/SubagentType'

const gp: SubagentType = {
  name: 'general-purpose',
  description: 'GP',
  systemPrompt: 's',
  allowedTools: '*',
}

const stubAdapters = () => ({
  settings: {
    load: async () => ({
      apiKey: 'k',
      baseUrl: 'http://x',
      model: 'm',
      systemPromptAddendum: '',
      toolMaxIterations: 5,
      toolMaxOutputChars: 1000,
    }),
  } as any,
  messageStore: {
    list: async () => [],
    append: async () => ({ id: 'm-1', createdAt: 0 }),
    update: async () => {},
    activeConversationId: async () => undefined,
  } as any,
  toolContext: { build: async () => ({}) } as any,
})

beforeEach(() => {
  ;(globalThis as any).chrome = {
    runtime: {
      onConnect: { addListener: () => {} },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    storage: { session: { setAccessLevel: () => {} } },
  }
})

describe('bootKernelOffscreen subagentTypes wiring', () => {
  it('boots without throwing when subagentTypes is omitted', () => {
    const a = stubAdapters()
    expect(() => bootKernelOffscreen({ ...a })).not.toThrow()
  })

  it('boots without throwing when subagentTypes is empty array', () => {
    const a = stubAdapters()
    expect(() => bootKernelOffscreen({ ...a, subagentTypes: [] })).not.toThrow()
  })

  it('boots without throwing when subagentTypes has entries', () => {
    const a = stubAdapters()
    expect(() => bootKernelOffscreen({ ...a, subagentTypes: [gp] })).not.toThrow()
  })

  it('throws on duplicate subagent type names', () => {
    const a = stubAdapters()
    expect(() => bootKernelOffscreen({ ...a, subagentTypes: [gp, gp] })).toThrow(
      /duplicate/i,
    )
  })
})
