import { describe, it, expect } from 'vitest'
import { buildTaskTool } from '../../../src/core/subagent/taskTool'
import { buildSubagentTypeRegistry } from '../../../src/core/subagent/SubagentType'
import { ToolRegistry } from '../../../src/core/ToolRegistry'
import type { SubagentType } from '../../../src/core/subagent/SubagentType'
import type { ToolExecContext, SubagentEventInput } from '../../../src/core/types'

const gp: SubagentType = {
  name: 'general-purpose',
  description: 'GP agent',
  systemPrompt: 'sys',
  allowedTools: '*',
}
const explore: SubagentType = {
  name: 'explore',
  description: 'Read-only',
  systemPrompt: 'sys',
  allowedTools: ['probe'],
}

const dummyLLM: any = {
  async *streamChat() {
    yield { kind: 'delta', text: 'done' }
    yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
  },
}

describe('buildTaskTool', () => {
  it('description lists all registered types with their descriptions', () => {
    const reg = buildSubagentTypeRegistry([gp, explore])
    const t = buildTaskTool(reg, dummyLLM)
    expect(t.description).toContain('general-purpose')
    expect(t.description).toContain('explore')
    expect(t.description).toContain('GP agent')
    expect(t.description).toContain('Read-only')
    expect(t.description.toLowerCase()).toContain('cannot nest')
  })

  it('input schema enum contains all type names', () => {
    const reg = buildSubagentTypeRegistry([gp, explore])
    const t = buildTaskTool(reg, dummyLLM)
    const enumValues = (t.inputSchema as any).properties.subagent_type.enum
    expect(enumValues).toEqual(['general-purpose', 'explore'])
  })

  it('execute returns ok with subagent final text', async () => {
    const reg = buildSubagentTypeRegistry([gp])
    const t = buildTaskTool(reg, dummyLLM)
    const events: SubagentEventInput[] = []
    const ctx: ToolExecContext = {
      signal: new AbortController().signal,
      turnId: 't-1',
      callId: 'c-1',
      emitSubagentEvent: (ev) => events.push(ev),
    }
    ;(ctx as any).__taskParentRegistry = new ToolRegistry([])
    const r = await t.execute(
      { subagent_type: 'general-purpose', description: 'd', prompt: 'p' },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBe('done')
    expect(events[0].kind).toBe('subagent/started')
  })

  it('execute returns error when subagent fails', async () => {
    const reg = buildSubagentTypeRegistry([gp])
    const failingLLM: any = {
      async *streamChat() {
        throw new Error('boom')
      },
    }
    const t = buildTaskTool(reg, failingLLM)
    const ctx: ToolExecContext = {
      signal: new AbortController().signal,
      turnId: 't-1',
      callId: 'c-1',
      emitSubagentEvent: () => {},
    }
    ;(ctx as any).__taskParentRegistry = new ToolRegistry([])
    const r = await t.execute(
      { subagent_type: 'general-purpose', description: 'd', prompt: 'p' },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('subagent_failed')
      expect(r.error.message).toContain('general-purpose failed')
      expect(r.error.retryable).toBe(false)
    }
  })

  it('execute requires ctx.turnId / callId / emitSubagentEvent', async () => {
    const reg = buildSubagentTypeRegistry([gp])
    const t = buildTaskTool(reg, dummyLLM)
    const ctx: ToolExecContext = { signal: new AbortController().signal }
    ;(ctx as any).__taskParentRegistry = new ToolRegistry([])
    const r = await t.execute(
      { subagent_type: 'general-purpose', description: 'd', prompt: 'p' },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('subagent_ctx_missing')
  })
})
