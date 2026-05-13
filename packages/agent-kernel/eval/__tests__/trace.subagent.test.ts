import { describe, it, expect } from 'vitest'
import { collectTrace } from '../core/trace'
import type { EngineEvent } from '../../src/core/QueryEngine'
import type { SubagentEventInput } from '../../src/core/types'

async function* gen(events: EngineEvent[]) {
  for (const e of events) yield e
}

describe('collectTrace — subagent + batchId', () => {
  it('pairs subagent/started + subagent/finished into subagent-spawn step', async () => {
    const events: SubagentEventInput[] = [
      {
        kind: 'subagent/started', subagentId: 's1',
        parentTurnId: 't', parentCallId: 'pc1',
        subagentType: 'general-purpose', description: 'd', prompt: 'p',
        startedAt: 1,
      },
      {
        kind: 'subagent/finished', subagentId: 's1',
        ok: true, text: 'final', iterations: 3, finishedAt: 2,
      },
    ]
    const trace = await collectTrace(
      gen([{ kind: 'done', stopReason: 'end_turn' } as any]),
      'task-1', 0, events,
    )
    const spawn = trace.steps.find((s) => s.kind === 'subagent-spawn')
    expect(spawn).toBeDefined()
    expect((spawn as any).subagentId).toBe('s1')
    expect((spawn as any).type).toBe('general-purpose')
    expect((spawn as any).ok).toBe(true)
    expect((spawn as any).finalText).toBe('final')
    expect((spawn as any).iterations).toBe(3)
    expect((spawn as any).parentCallId).toBe('pc1')
  })

  it('records ok=false when finished has error', async () => {
    const events: SubagentEventInput[] = [
      { kind: 'subagent/started', subagentId: 's1', parentTurnId: 't', parentCallId: 'pc1', subagentType: 'gp', description: 'd', prompt: 'p', startedAt: 1 },
      { kind: 'subagent/finished', subagentId: 's1', ok: false, error: { code: 'aborted', message: 'x' }, iterations: 1, finishedAt: 2 },
    ]
    const trace = await collectTrace(gen([{ kind: 'done', stopReason: 'end_turn' } as any]), 't', 0, events)
    const spawn = trace.steps.find((s) => s.kind === 'subagent-spawn') as any
    expect(spawn.ok).toBe(false)
    expect(spawn.error.code).toBe('aborted')
  })

  it('unmatched started (no finished) produces ok=false step with unfinished error', async () => {
    const events: SubagentEventInput[] = [
      { kind: 'subagent/started', subagentId: 's1', parentTurnId: 't', parentCallId: 'pc1', subagentType: 'gp', description: 'd', prompt: 'p', startedAt: 1 },
    ]
    const trace = await collectTrace(gen([{ kind: 'done', stopReason: 'end_turn' } as any]), 't', 0, events)
    const spawn = trace.steps.find((s) => s.kind === 'subagent-spawn') as any
    expect(spawn).toBeDefined()
    expect(spawn.ok).toBe(false)
    expect(spawn.error.code).toBe('unfinished')
  })

  it('tool-call steps emitted by same assistant_message_complete share a batchId', async () => {
    const trace = await collectTrace(
      gen([
        {
          kind: 'assistant_message_complete',
          text: '',
          toolCalls: [
            { id: 'c1', name: 'foo', input: {} },
            { id: 'c2', name: 'bar', input: {} },
          ],
        } as any,
        { kind: 'done', stopReason: 'end_turn' } as any,
      ]),
      't', 0, [],
    )
    const calls = trace.steps.filter((s) => s.kind === 'tool-call') as any[]
    expect(calls).toHaveLength(2)
    expect(calls[0].batchId).toBeDefined()
    expect(calls[0].batchId).toBe(calls[1].batchId)
  })

  it('tool-calls from different assistant iterations have different batchIds', async () => {
    const trace = await collectTrace(
      gen([
        { kind: 'assistant_message_complete', text: '', toolCalls: [{ id: 'c1', name: 'foo', input: {} }] } as any,
        { kind: 'tool_result', callId: 'c1', content: 'r', isError: false } as any,
        { kind: 'assistant_message_complete', text: '', toolCalls: [{ id: 'c2', name: 'bar', input: {} }] } as any,
        { kind: 'done', stopReason: 'end_turn' } as any,
      ]),
      't', 0, [],
    )
    const calls = trace.steps.filter((s) => s.kind === 'tool-call') as any[]
    expect(calls[0].batchId).not.toBe(calls[1].batchId)
  })

  it('handles empty subagentEvents (backward compat)', async () => {
    const trace = await collectTrace(
      gen([{ kind: 'done', stopReason: 'end_turn' } as any]),
      't', 0, [],
    )
    expect(trace.steps.filter((s) => s.kind === 'subagent-spawn')).toHaveLength(0)
  })
})
