import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '@core/ToolRegistry'
import type { ToolDefinition } from '@core'

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'noop',
  inputSchema: { type: 'object', properties: {} },
  exec: 'offscreen',
  async execute() {
    return { ok: true, data: 'ok' }
  },
}

describe('ToolRegistry', () => {
  let r: ToolRegistry
  beforeEach(() => {
    r = new ToolRegistry()
  })

  it('registers and looks up by name', () => {
    r.register(noopTool)
    expect(r.get('noop')).toBe(noopTool)
  })

  it('all() returns enabled tools', () => {
    r.register(noopTool)
    expect(r.all().length).toBe(1)
  })

  it('throws on duplicate name', () => {
    r.register(noopTool)
    expect(() => r.register(noopTool)).toThrow(/duplicate/i)
  })

  it('toOpenAi() emits compatible shape', () => {
    r.register(noopTool)
    const tools = r.toOpenAi()
    expect(tools[0]).toEqual({
      type: 'function',
      function: { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } },
    })
  })
})
