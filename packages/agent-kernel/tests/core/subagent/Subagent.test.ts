import { describe, it, expect, vi } from 'vitest'
import { Subagent, SubagentFailedError } from '../../../src/core/subagent/Subagent'
import type { SubagentType } from '../../../src/core/subagent/SubagentType'
import { ToolRegistry } from '../../../src/core/ToolRegistry'
import type {
  ToolDefinition,
  ToolExecContext,
  SubagentId,
  SubagentEventInput,
} from '../../../src/core/types'
import type { OpenAICompatibleClient } from '../../../src/core/OpenAICompatibleClient'

function makeLLM(script: Array<() => any>): OpenAICompatibleClient {
  let i = 0
  return {
    async *streamChat() {
      const step = script[i++]
      if (!step) throw new Error('script exhausted')
      yield* step()
    },
  } as any
}

const baseType: SubagentType = {
  name: 'gp',
  description: 'd',
  systemPrompt: 'You are a sub-agent.',
  allowedTools: '*',
  maxIterations: 5,
}

function makeProbe(name: string, result = 'r'): ToolDefinition<any, string> {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    async execute() {
      return { ok: true, data: result }
    },
  }
}

describe('Subagent.run', () => {
  it('returns assistant text on simple end_turn', async () => {
    const llm = makeLLM([
      async function* () {
        yield { kind: 'delta', text: 'hello world' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    ])
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-1' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'say hi',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([]),
      llm,
      emit: (ev) => events.push(ev),
    })
    const r = await sa.run()
    expect(r.text).toBe('hello world')
    expect(r.iterations).toBe(1)
    const kinds = events.map((e) => e.kind)
    expect(kinds[0]).toBe('subagent/started')
    expect(kinds[kinds.length - 1]).toBe('subagent/finished')
  })

  it('handles a tool-call iteration then final text', async () => {
    const llm = makeLLM([
      async function* () {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'tc-1', name: 'probe', input: {} }],
        }
      },
      async function* () {
        yield { kind: 'delta', text: 'done' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    ])
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-2' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([makeProbe('probe')]),
      llm,
      emit: (ev) => events.push(ev),
    })
    const r = await sa.run()
    expect(r.text).toBe('done')
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('subagent/tool_call')
    expect(kinds).toContain('subagent/tool_end')
  })

  it('throws SubagentFailedError max_iterations_no_result when only tool calls', async () => {
    const llm = makeLLM([
      async function* () {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'a', name: 'probe', input: {} }],
        }
      },
      async function* () {
        yield {
          kind: 'done',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'b', name: 'probe', input: {} }],
        }
      },
    ])
    const typ = { ...baseType, maxIterations: 2 }
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-3' as SubagentId,
      type: typ,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([makeProbe('probe')]),
      llm,
      emit: (ev) => events.push(ev),
    })
    await expect(sa.run()).rejects.toMatchObject({
      name: 'SubagentFailedError',
      code: 'max_iterations_no_result',
    })
    const last = events[events.length - 1]
    expect(last.kind).toBe('subagent/finished')
    expect((last as any).ok).toBe(false)
  })

  it('throws SubagentFailedError llm_error when LLM throws', async () => {
    const llm: any = {
      async *streamChat() {
        throw new Error('boom')
      },
    }
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-4' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([]),
      llm,
      emit: (ev) => events.push(ev),
    })
    await expect(sa.run()).rejects.toMatchObject({
      code: 'llm_error',
    })
  })

  it('aborts when parent signal aborts', async () => {
    let resolveStarted: () => void = () => {}
    const started = new Promise<void>((res) => (resolveStarted = res))
    const llm: any = {
      async *streamChat({ signal }: any) {
        resolveStarted()
        await new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('AbortError'))))
      },
    }
    const ac = new AbortController()
    const events: SubagentEventInput[] = []
    const sa = new Subagent({
      id: 'sid-5' as SubagentId,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: ac.signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([]),
      llm,
      emit: (ev) => events.push(ev),
    })
    const p = sa.run()
    await started
    ac.abort()
    await expect(p).rejects.toBeDefined()
    const fin = events.find((e) => e.kind === 'subagent/finished') as any
    expect(fin?.ok).toBe(false)
  })

  it('filters out Task tool from child registry even when allowedTools is "*"', async () => {
    const taskTool = makeProbe('Task')
    const visibleNames: string[] = []
    const llm: any = {
      async *streamChat({ tools }: any) {
        for (const t of tools ?? []) visibleNames.push(t.function.name)
        yield { kind: 'delta', text: 'ok' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    }
    const sa = new Subagent({
      id: 'sid-6' as SubagentId,
      type: { ...baseType, allowedTools: '*' },
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([taskTool, makeProbe('probe')]),
      llm,
      emit: () => {},
    })
    await sa.run()
    expect(visibleNames).toContain('probe')
    expect(visibleNames).not.toContain('Task')
  })

  it('restricts child tools to allowedTools whitelist', async () => {
    const visibleNames: string[] = []
    const llm: any = {
      async *streamChat({ tools }: any) {
        for (const t of tools ?? []) visibleNames.push(t.function.name)
        yield { kind: 'delta', text: 'ok' }
        yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
      },
    }
    const sa = new Subagent({
      id: 'sid-7' as SubagentId,
      type: { ...baseType, allowedTools: ['probe'] },
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: {} as ToolExecContext,
      registry: new ToolRegistry([makeProbe('probe'), makeProbe('other')]),
      llm,
      emit: () => {},
    })
    await sa.run()
    expect(visibleNames).toEqual(['probe'])
  })

  it('uses subagentId as ToolExecContext.conversationId for child tool calls', async () => {
    let observedCid: string | undefined
    const probe: ToolDefinition<any, string> = {
      name: 'probe',
      description: '',
      inputSchema: { type: 'object' },
      async execute(_input, ctx) {
        observedCid = ctx.conversationId
        return { ok: true, data: 'x' }
      },
    }
    let i = 0
    const llm2: any = {
      async *streamChat() {
        if (i++ === 0) {
          yield {
            kind: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'tc-1', name: 'probe', input: {} }],
          }
        } else {
          yield { kind: 'delta', text: 'done' }
          yield { kind: 'done', stopReason: 'stop', toolCalls: [] }
        }
      },
    }
    const sid = 'sid-8' as SubagentId
    const sa = new Subagent({
      id: sid,
      type: baseType,
      parentTurnId: 't-1',
      parentCallId: 'c-1',
      userPrompt: 'hi',
      userDescription: 'd',
      parentSignal: new AbortController().signal,
      parentCtx: { conversationId: 'parent-cid' as any } as ToolExecContext,
      registry: new ToolRegistry([probe]),
      llm: llm2,
      emit: () => {},
    })
    await sa.run()
    expect(observedCid).toBe(sid)
  })
})
