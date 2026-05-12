// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  createAgent,
  createAgentService,
  makeOk,
  makeError,
  SkillRegistry,
  createUseSkillTool,
  createReadSkillFileTool,
  type ChatMessage,
  type ToolDefinition,
  type AgentEvent,
  type MessageStoreAdapter,
  type MessageRecord,
} from 'agent-kernel'

// Live-LLM integration tests against a real OpenAI-compatible endpoint.
// Skipped by default — they cost tokens and need network. Two ways to run:
//
//   1) cp .env.example .env   # then fill in MYCLI_TEST_API_KEY
//      bun run test:live
//
//   2) one-shot:
//      MYCLI_TEST_API_KEY=sk-xxx \
//      MYCLI_TEST_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
//      MYCLI_TEST_MODEL=glm-4-flash \
//      bun run test:live
//
// Defaults if vars are missing: api.openai.com / gpt-4o-mini. The .env.example
// in this package is preconfigured for Zhipu BigModel (the project's primary
// dev target) so the easiest path is `cp .env.example .env`, drop in a key,
// and run.

// node types aren't declared for the tests project, so reach for env via
// globalThis to keep this file from forcing a tsconfig change.
const env =
  ((globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env) ?? {}
const apiKey = env.MYCLI_TEST_API_KEY ?? ''
const baseUrl = env.MYCLI_TEST_BASE_URL ?? 'https://api.openai.com/v1'
const model = env.MYCLI_TEST_MODEL ?? 'gpt-4o-mini'
const live = !!apiKey

function buildAgent(
  tools: ToolDefinition<any, any, any>[] = [],
  opts: { toolMaxIterations?: number; system?: string } = {},
) {
  return createAgent({
    llm: { apiKey, baseUrl, model },
    tools,
    toolContext: {},
    systemPrompt: opts.system,
    toolMaxIterations: opts.toolMaxIterations,
  })
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const ev of stream) events.push(ev)
  return events
}

describe.skipIf(!live)('agent live integration (real LLM)', () => {
  if (live) {
    // eslint-disable-next-line no-console
    console.log(
      `[live] testing against ${baseUrl} with model=${model} (key …${apiKey.slice(-4)})`,
    )
  }

  it('1. basic chat — LLM responds', async () => {
    const agent = buildAgent()
    const events = await collect(
      agent.send('What is 2 + 2? Reply with just the number, nothing else.'),
    )
    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      expect(done.assistantText).toMatch(/4/)
      expect(done.stopReason).toBe('end_turn')
    }
  }, 30_000)

  it('2. streaming — chunks arrive incrementally, not all-at-once', async () => {
    const agent = buildAgent()
    const chunkAtMs: number[] = []
    const t0 = Date.now()
    for await (const ev of agent.send(
      'Count from 1 to 20, putting each number on its own line.',
    )) {
      if (ev.kind === 'message/streamChunk') chunkAtMs.push(Date.now() - t0)
    }
    expect(chunkAtMs.length).toBeGreaterThanOrEqual(2)
    const span = chunkAtMs[chunkAtMs.length - 1] - chunkAtMs[0]
    // Span > 50ms means chunks really were async, not buffered into one
    // synthetic chunk by a non-streaming proxy.
    expect(span).toBeGreaterThan(50)
  }, 30_000)

  it('3. tool call single hop — LLM invokes a custom tool and uses the result', async () => {
    const getServerTime: ToolDefinition<Record<string, never>, { time: string }, any> = {
      name: 'getServerTime',
      description:
        'Returns the current time on the server in ISO format. ' +
        'Use this whenever you need to know what year, month, day, or time it is.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => makeOk({ time: '2099-07-15T12:00:00Z' }),
    }
    const agent = buildAgent([getServerTime])
    const events = await collect(
      agent.send(
        'Call the getServerTime tool, then tell me what year it returned. ' +
          'Reply with just the year as a 4-digit number.',
      ),
    )

    const toolStarts = events.filter((e) => e.kind === 'tool/start')
    const toolEnds = events.filter((e) => e.kind === 'tool/end')
    expect(toolStarts.length).toBeGreaterThanOrEqual(1)
    expect(toolEnds.length).toBeGreaterThanOrEqual(1)
    if (toolStarts[0].kind === 'tool/start') {
      expect(toolStarts[0].toolCall.tool).toBe('getServerTime')
    }

    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      // Pinned to a fake-future date so we know the LLM actually used the
      // tool result and didn't just hallucinate the current year.
      expect(done.assistantText).toMatch(/2099/)
    }
  }, 60_000)

  it('4. tool error handling — LLM acknowledges tool failure', async () => {
    const failingTool: ToolDefinition<Record<string, never>, never, any> = {
      name: 'doSomething',
      description: 'Performs a critical action on behalf of the user.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () =>
        makeError(
          'service_down',
          'The remote service is unreachable. Cannot perform this action.',
        ),
    }
    const agent = buildAgent([failingTool])
    const events = await collect(
      agent.send(
        'Call doSomething once, then tell me in your own words whether it succeeded.',
      ),
    )

    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      // The LLM should mention failure / error / unreachable rather than claim success.
      expect(done.assistantText.toLowerCase()).toMatch(
        /error|fail|unreachable|service|cannot|did ?n['’]?t|unable/,
      )
    }
  }, 60_000)

  it('5. multi-turn — explicit history retention works', async () => {
    const agent = buildAgent()
    const history: ChatMessage[] = []

    // Turn 1
    const text1 = 'My favorite color is purple. Reply with just the word "noted".'
    const ev1 = await collect(agent.send(text1, { history }))
    const done1 = ev1.find((e) => e.kind === 'done')
    expect(done1).toBeDefined()
    if (!done1 || done1.kind !== 'done') return
    history.push({ role: 'user', content: text1 })
    history.push({ role: 'assistant', content: done1.assistantText })

    // Turn 2 — should resolve based on remembered context
    const text2 = 'What color did I just say is my favorite? Reply with just the color word.'
    const ev2 = await collect(agent.send(text2, { history }))
    const done2 = ev2.find((e) => e.kind === 'done')
    expect(done2).toBeDefined()
    if (done2 && done2.kind === 'done') {
      expect(done2.assistantText.toLowerCase()).toMatch(/purple/)
    }
  }, 90_000)

  it('6. max_iterations — agent halts when tool loop exceeds budget', async () => {
    let calls = 0
    const tryAgain: ToolDefinition<Record<string, never>, { msg: string }, any> = {
      name: 'tryAgain',
      description:
        'Tries an operation. The result will instruct you whether to call it again. ' +
        'Always follow the instruction in the result.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        calls += 1
        return makeOk({
          msg: 'Almost there. Call tryAgain one more time to finish.',
        })
      },
    }
    const agent = buildAgent([tryAgain], { toolMaxIterations: 2 })
    const events = await collect(
      agent.send(
        'Call tryAgain. Always follow the instructions in its return value. Do not stop early.',
      ),
    )

    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      expect(done.stopReason).toBe('max_iterations')
    }
    // Hard cap: agent must not have called the tool more than max times.
    expect(calls).toBeLessThanOrEqual(2)
  }, 60_000)

  it('7. abort — cancel() halts a running turn quickly', async () => {
    const agent = buildAgent()
    const t0 = Date.now()
    const stream = agent.send(
      'Write a 5000-word essay about artificial intelligence. ' +
        'Be very thorough and cover history, architectures, applications, and ethics.',
    )
    setTimeout(() => agent.cancel(), 200)

    const events = await collect(stream)
    const elapsed = Date.now() - t0
    const done = events.find((e) => e.kind === 'done')

    expect(done).toBeDefined()
    expect(elapsed).toBeLessThan(5000)
    if (done && done.kind === 'done') {
      // Either the engine surfaces 'cancel' or the client surfaces 'error' from
      // the aborted fetch — both are acceptable cancellation signals.
      expect(['cancel', 'error']).toContain(done.stopReason)
    }
  }, 30_000)

  // ---------- 9. Token usage event ----------
  // Documents whether the configured provider returns prompt_tokens in the
  // streaming response. Some providers (notably Zhipu BigModel as of 2026-05)
  // ignore stream_options.include_usage and never send a usage chunk, which
  // means the agent's `usage` event never fires for them. We don't fail the
  // test in that case — we just record what the provider does so future
  // regressions are obvious from the test output.
  it('9. usage — provider may or may not return prompt_tokens', async () => {
    const agent = buildAgent()
    const events = await collect(
      agent.send('Reply with a single short word: "ok".'),
    )
    const usageEvents = events.filter((e) => e.kind === 'usage')
    if (usageEvents.length === 0) {
      console.warn(
        `[live] provider ${baseUrl} did not emit usage on the stream. ` +
          'Context bar will not update for this provider.',
      )
    } else {
      // If usage IS reported, both fields must be non-negative integers.
      for (const ev of usageEvents) {
        if (ev.kind !== 'usage') continue
        expect(ev.input).toBeGreaterThanOrEqual(0)
        expect(ev.output).toBeGreaterThanOrEqual(0)
      }
    }
    // Either way, the turn must complete cleanly.
    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      expect(done.stopReason).toBe('end_turn')
    }
  }, 30_000)

  // ---------- cached_tokens propagation (T5 of prompt-cache-observability) ----------
  // Validates the field-chain (defaultUsageParser → client → engine → session →
  // service → wire). Does NOT assert cached > 0 — cold cache may not hit, and
  // providers vary on whether they expose cached_tokens at all. Field must
  // either be a number (when reported) or absent/undefined.
  it('14. cached usage — cached field is plumbed through usage events', async () => {
    // Use a longer-than-default system prompt so providers that auto-cache have
    // something stable to cache against across requests within this test run.
    const stableSystem = `You are a helpful assistant. ${'X'.repeat(2000)}`
    const agent = buildAgent([], { system: stableSystem })
    const events = await collect(
      agent.send('Reply with a single short word: "ok".'),
    )
    const usageEvents = events.filter((e) => e.kind === 'usage')
    if (usageEvents.length === 0) {
      console.warn(
        `[live] provider ${baseUrl} did not emit usage on the stream — ` +
          'cannot verify cached plumbing for this provider.',
      )
    } else {
      for (const ev of usageEvents) {
        if (ev.kind !== 'usage') continue
        // The field must either be a non-negative number or absent.
        // Note: 'cached' may not appear on every event from every provider.
        expect(['number', 'undefined']).toContain(typeof ev.cached)
        if (typeof ev.cached === 'number') {
          expect(ev.cached).toBeGreaterThanOrEqual(0)
        }
      }
    }
    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
  }, 30_000)

  // ---------- 10. Tool result truncation actually shrinks the LLM view ----------
  // We give the model a tool that returns a 60KB blob with a secret marker
  // hidden well past the 1000-char cap. With truncation enabled, the LLM
  // shouldn't see the marker; without it, it would. We assert the LLM either
  // fails to find it or admits it can't see it — verifying truncation took
  // effect end-to-end (not just unit-tested).
  it('10. tool truncation — large tool output is capped before reaching LLM', async () => {
    const SECRET = 'PURPLE-OCTOPUS-9417'
    // 60KB filler followed by the secret. With toolMaxOutputChars=500, the
    // LLM never sees the secret in the tool result.
    const body = 'lorem ipsum '.repeat(5000) + ` ${SECRET} ` + 'tail'.repeat(500)

    const bigDocTool: ToolDefinition<Record<string, never>, { text: string }, any> = {
      name: 'fetchBigDoc',
      description:
        'Returns a large document. Search its full text for any keyword the user asks about.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => makeOk({ text: body }),
    }

    const agent = createAgent({
      llm: { apiKey, baseUrl, model },
      tools: [bigDocTool],
      toolContext: {},
      toolMaxOutputChars: 500, // aggressive cap so the secret falls outside
    })

    const events = await collect(
      agent.send(
        `Call fetchBigDoc, then tell me whether the document contains the exact ` +
          `string "${SECRET}". Answer YES or NO with a brief reason.`,
      ),
    )

    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      const text = done.assistantText.toLowerCase()
      // The LLM must not claim it saw the secret. Acceptable answers:
      //   - "no" / "doesn't appear" / "not present"
      //   - "truncated" / "can't see" / "cut off" (the LLM noticed the marker)
      // Unacceptable: a confident "yes" with the secret string echoed.
      const claimsYes =
        /\byes\b/.test(text) && text.includes(SECRET.toLowerCase())
      expect(claimsYes).toBe(false)
    }
  }, 60_000)

  // ---------- 11. Multi-iteration tool flow ----------
  // Forces the LLM to use a tool, get a result, then use it AGAIN with
  // different args derived from the first result. This exercises the
  // assistant/iter event boundary and the same-turn history accumulation.
  it('11. multi-iteration — LLM chains two tool calls in one turn', async () => {
    let firstArgs: any = null
    let secondArgs: any = null
    const lookup: ToolDefinition<{ key: string }, { value: string }, any> = {
      name: 'lookup',
      description:
        'Look up a value by key. Known keys: "first" returns "use the key second next". ' +
        '"second" returns "the answer is 42".',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      execute: async (input) => {
        if (firstArgs === null) firstArgs = input
        else if (secondArgs === null) secondArgs = input
        if (input.key === 'first') return makeOk({ value: 'use the key second next' })
        if (input.key === 'second') return makeOk({ value: 'the answer is 42' })
        return makeOk({ value: 'unknown key' })
      },
    }

    const agent = buildAgent([lookup])
    const events = await collect(
      agent.send(
        'Call the lookup tool with key="first", read the result, then call lookup again ' +
          'with whatever key the result tells you. Then report just the final answer string.',
      ),
    )

    const toolStarts = events.filter((e) => e.kind === 'tool/start')
    expect(toolStarts.length).toBeGreaterThanOrEqual(2)

    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      expect(done.assistantText).toMatch(/42/)
    }
    // Order matters: first call uses key="first", second uses key="second".
    expect(firstArgs?.key).toBe('first')
    expect(secondArgs?.key).toBe('second')
  }, 90_000)

  // ---------- 12. agentService full stack with in-memory store ----------
  // Drives the production code path (agentService.runTurn) end-to-end with a
  // real LLM. Verifies that across turns the assistant message rows AND tool
  // rows get persisted with the correct roles + tool_calls / tool_call_id —
  // the bones of how the agent remembers what it did last turn.
  it('12. agentService — persists assistant + tool rows across two turns', async () => {
    const records: MessageRecord[] = []
    const wireEvents: any[] = []

    const inMemStore: MessageStoreAdapter = {
      async activeConversationId() {
        return 'conv-test'
      },
      async append(msg) {
        const row: MessageRecord = {
          id: `m-${records.length + 1}`,
          role: msg.role,
          content: msg.content,
          createdAt: Date.now() + records.length,
          pending: msg.pending,
          toolCalls: msg.toolCalls,
          toolCallId: msg.toolCallId,
        }
        records.push(row)
        return { id: row.id, createdAt: row.createdAt }
      },
      async list() {
        return [...records]
      },
      async update(id, patch) {
        const r = records.find((m) => m.id === id)
        if (r) {
          if (patch.content !== undefined) r.content = patch.content
          if (patch.pending !== undefined) r.pending = patch.pending
          if (patch.toolCalls !== undefined) r.toolCalls = patch.toolCalls
        }
      },
    }

    const flagTool: ToolDefinition<Record<string, never>, { flag: string }, any> = {
      name: 'getFlag',
      description: 'Returns a single secret flag string the user asked for.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => makeOk({ flag: 'AURORA-7782' }),
    }

    const svc = createAgentService({
      settings: {
        load: async () => ({
          apiKey,
          baseUrl,
          model,
          toolMaxIterations: 5,
        }),
      },
      emit: (ev) => wireEvents.push(ev),
      messageStore: inMemStore,
      toolContext: {
        build: async () => ({ rpc: { domOp: () => {}, chromeApi: () => {} } }),
      },
      tools: [flagTool],
    })

    // Turn 1: force a tool call.
    await svc.runTurn({
      sessionId: '00000000-0000-0000-0000-000000000001',
      text: 'Call getFlag and tell me the flag value verbatim.',
    })

    // After turn 1 we expect at minimum: 1 user, ≥1 assistant (with toolCalls),
    // ≥1 tool, ≥1 assistant (final answer).
    expect(records.find((r) => r.role === 'user')).toBeDefined()
    const assistantRows = records.filter((r) => r.role === 'assistant')
    expect(assistantRows.length).toBeGreaterThanOrEqual(1)
    const toolRow = records.find((r) => r.role === 'tool')
    expect(toolRow).toBeDefined()
    expect(toolRow!.toolCallId).toMatch(/.+/) // some non-empty id
    const assistantWithToolCalls = assistantRows.find(
      (r) => r.toolCalls && r.toolCalls.length > 0,
    )
    expect(assistantWithToolCalls).toBeDefined()
    expect(assistantWithToolCalls!.toolCalls![0].name).toBe('getFlag')

    // Turn 2: ask about the prior result. The LLM should NOT need to re-call
    // because the tool row is in history — but we don't strictly assert that.
    // We do assert the LLM correctly reports the flag value.
    const turn1ToolCallCount = records.filter((r) => r.role === 'tool').length
    await svc.runTurn({
      sessionId: '00000000-0000-0000-0000-000000000001',
      text: 'What was the flag value you got? Reply with just the flag string.',
    })
    const finalAssistant = records[records.length - 1]
    expect(finalAssistant.role).toBe('assistant')
    expect(String(finalAssistant.content)).toMatch(/AURORA-7782/)

    // Track whether turn 2 re-called the tool — informational, not an
    // assertion (LLMs sometimes choose to re-verify).
    const turn2ToolCallCount =
      records.filter((r) => r.role === 'tool').length - turn1ToolCallCount
    console.log(
      `[live] turn 2 re-called the tool ${turn2ToolCallCount} time(s). ` +
        '0 means the LLM correctly used the persisted tool result from turn 1.',
    )
  }, 120_000)

  it('8. skill flow — LLM calls useSkill and follows its instructions', async () => {
    // Build a skill registry with one skill that delegates to a fake readPage.
    const registry = new SkillRegistry()
    registry.register({
      name: 'summarizePage',
      description: 'Summarize the current page in exactly two short bullet points.',
      body: [
        'Use the readPage tool with no arguments to fetch the current page.',
        'Then reply with exactly two markdown bullet points summarizing it.',
      ].join('\n'),
      files: {},
    })

    const fakePage =
      'Bunnies are small mammals. They have long ears. They eat carrots.'
    const readPage: ToolDefinition<Record<string, never>, { text: string }, any> = {
      name: 'readPage',
      description: 'Returns the plain-text content of the current web page.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => makeOk({ text: fakePage }),
    }

    const useSkill = createUseSkillTool({ registry })
    const readSkillFile = createReadSkillFileTool({ registry })

    const agent = buildAgent([readPage, useSkill, readSkillFile])
    const events = await collect(
      agent.send('Use the summarizePage skill to summarize the active page.'),
    )

    const toolStarts = events.filter((e) => e.kind === 'tool/start')
    const calledTools = toolStarts.map(
      (e) => (e.kind === 'tool/start' ? e.toolCall.tool : ''),
    )
    // Must have called useSkill at some point.
    expect(calledTools).toContain('useSkill')
    // Must have called readPage to fulfill the skill's instructions.
    expect(calledTools).toContain('readPage')

    const done = events.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
    if (done && done.kind === 'done') {
      // Final answer should reference content the fake readPage returned.
      expect(done.assistantText.toLowerCase()).toMatch(/bunn|ear|carrot/)
    }
  }, 60_000)
})
