// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  createAgent,
  makeOk,
  makeError,
  SkillRegistry,
  createUseSkillTool,
  createReadSkillFileTool,
  type ChatMessage,
  type ToolDefinition,
  type AgentEvent,
} from 'agent-kernel'

// Live-LLM integration tests. Skipped by default — set MYCLI_TEST_API_KEY in
// the environment to run them. They make real network calls and consume
// tokens, so they don't run as part of `bun run test` unless opted into.
//
//   MYCLI_TEST_API_KEY=sk-xxx \
//   MYCLI_TEST_BASE_URL=https://api.openai.com/v1 \
//   MYCLI_TEST_MODEL=gpt-4o-mini \
//   bun run test tests/integration/agent.live.test.ts
//
// MYCLI_TEST_BASE_URL and MYCLI_TEST_MODEL are optional and default to
// OpenAI + gpt-4o-mini.

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
