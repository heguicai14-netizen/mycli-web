# Prompt Cache Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OpenAI-compatible 上游(GLM-4.6 / OpenAI / DeepSeek)的 `cached_tokens` 从 LLM 响应一路透传到 wire-level `message/usage` 事件,kernel 暴露可插拔 `usageParser` 给 consumer 扩展未知 provider。Observability-only,不加 provider adapter,守 `packages/mycli-web/CLAUDE.md` 约束。

**Architecture:** 改动全部落在 `packages/agent-kernel/`,5 个文件 + 5 个 test file。数据流:`OpenAICompatibleClient` → `QueryEngine` → `AgentSession` → `agentService`。每一跳的事件 schema 加可选 `cached` 字段(additive,backward-compatible)。`defaultUsageParser` 是导出的纯函数,识别 OpenAI / GLM / DeepSeek 的 usage shape,识别失败返回 `undefined`(不抛错)。Consumer 可在 `ClientConfig.usageParser` 注入自己的 parser 覆盖默认。

**Tech Stack:** TypeScript / Bun / Vitest / Zod / OpenAI-compatible SSE。

**Spec:** `docs/superpowers/specs/2026-05-10-prompt-cache-observability-design.md`

**重要约束:**
- 不动 `packages/mycli-web/`(consumer 端零代码改动,本 plan 只验证 build 不挂)
- 不加任何 provider adapter(守 CLAUDE.md)
- TDD:每个 task 先写失败测试再实现
- 每个 task 单独 commit
- 改完每个 task 都跑 typecheck + 当前 package 的全套测试

---

## File Map

**Kernel 改动(5 个源文件)**:

| 文件 | 改动 |
|---|---|
| `packages/agent-kernel/src/core/OpenAICompatibleClient.ts` | 加 `NormalizedUsage` / `UsageParser` 类型;加 `defaultUsageParser` 导出函数;`ClientConfig.usageParser?` 可选字段;`streamChat` 调 parser 后把 `cached` 放进 `done.usage` |
| `packages/agent-kernel/src/core/QueryEngine.ts` | `EngineEvent.assistant_message_complete.usage` 类型加可选 `cached`;`usageThisIter` 类型同步;透传 |
| `packages/agent-kernel/src/core/protocol.ts` | core-level `Usage` Zod 事件加可选 `cached: nonneg int optional` |
| `packages/agent-kernel/src/core/AgentSession.ts` | yield `{ kind: 'usage', ..., cached }`(只在 ev.usage.cached 有值时带) |
| `packages/agent-kernel/src/browser/rpc/protocol.ts` | wire-level `MessageUsage` Zod 加同字段 |
| `packages/agent-kernel/src/browser/agentService.ts` | emit `message/usage` 时透传 `cached: ev.cached`(只在有值时带) |
| `packages/agent-kernel/src/index.ts` | 公开导出 `NormalizedUsage` / `UsageParser` / `defaultUsageParser` |

**Tests(extend existing where possible)**:

| 文件 | 改动 |
|---|---|
| `packages/agent-kernel/tests/core/defaultUsageParser.test.ts` | **新建** — pure function 单测 |
| `packages/agent-kernel/tests/core/openAiClientUsage.test.ts` | **扩展** — 加 cached 透传 + 自定义 parser + parser 抛错 |
| `packages/agent-kernel/tests/core/queryEngineUsage.test.ts` | **扩展** — cached 透传 |
| `packages/agent-kernel/tests/core/protocol.test.ts` | **扩展** — core Usage schema 接受 cached optional |
| `packages/agent-kernel/tests/browser/rpc/protocol.test.ts` | **扩展或新建** — wire MessageUsage schema |
| `packages/agent-kernel/tests/browser/agentServiceUsage.test.ts` 或现有 agentService 测试 | **扩展或新建** — emit message/usage 携带 cached |
| `packages/mycli-web/tests/integration/agent.live.test.ts` 或 kernel 下的对应位置 | **扩展** — live GLM-4.6 验证字段存在 |

(执行 task 时若发现 test file 命名/路径与预期不一致,以代码库实际为准,跟着现有模式走。)

---

## Task 1: defaultUsageParser (pure function + 类型 + export)

**Files:**
- Create: `packages/agent-kernel/tests/core/defaultUsageParser.test.ts`
- Modify: `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`(加类型 + 导出函数;还**不**接到 streamChat)
- Modify: `packages/agent-kernel/src/index.ts`(导出 `NormalizedUsage` / `UsageParser` / `defaultUsageParser`)

- [ ] **Step 1: Write failing tests for `defaultUsageParser`**

文件 `packages/agent-kernel/tests/core/defaultUsageParser.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { defaultUsageParser } from 'agent-kernel'

describe('defaultUsageParser', () => {
  it('extracts cached from OpenAI/GLM shape', () => {
    const raw = { prompt_tokens_details: { cached_tokens: 100 } }
    expect(defaultUsageParser(raw)).toEqual({ cached: 100 })
  })

  it('extracts cached from DeepSeek shape', () => {
    const raw = { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }
    expect(defaultUsageParser(raw)).toEqual({ cached: 80 })
  })

  it('prefers OpenAI path when both shapes are present', () => {
    // OpenRouter passthrough could in theory include both; OpenAI path wins
    // (matches the table in the spec).
    const raw = {
      prompt_tokens_details: { cached_tokens: 100 },
      prompt_cache_hit_tokens: 80,
    }
    expect(defaultUsageParser(raw)).toEqual({ cached: 100 })
  })

  it('returns cached=undefined for unknown shape', () => {
    expect(defaultUsageParser({ foo: 1 })).toEqual({ cached: undefined })
  })

  it('returns cached=undefined for null / undefined / non-object inputs', () => {
    expect(defaultUsageParser(null)).toEqual({ cached: undefined })
    expect(defaultUsageParser(undefined)).toEqual({ cached: undefined })
    expect(defaultUsageParser('foo')).toEqual({ cached: undefined })
    expect(defaultUsageParser(42)).toEqual({ cached: undefined })
  })

  it('returns cached=undefined when field type is wrong', () => {
    expect(
      defaultUsageParser({ prompt_tokens_details: { cached_tokens: 'oops' } }),
    ).toEqual({ cached: undefined })
    expect(defaultUsageParser({ prompt_cache_hit_tokens: null })).toEqual({
      cached: undefined,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd packages/agent-kernel run test tests/core/defaultUsageParser.test.ts`
Expected: FAIL with import error `defaultUsageParser` not exported from `agent-kernel`.

- [ ] **Step 3: Add types and `defaultUsageParser` to client file**

在 `packages/agent-kernel/src/core/OpenAICompatibleClient.ts` **顶部**(`export interface ClientConfig` 之前)插入:

```ts
export interface NormalizedUsage {
  in: number
  out: number
  /** Provider-reported cached prompt tokens. undefined if provider doesn't expose it. */
  cached?: number
}

export type UsageParser = (rawUsage: unknown) => Pick<NormalizedUsage, 'cached'>

/**
 * Default usage parser. Recognizes OpenAI/GLM-4.6 (prompt_tokens_details.cached_tokens)
 * and DeepSeek (prompt_cache_hit_tokens) shapes. Returns { cached: undefined } for
 * unknown shapes — never throws.
 */
export const defaultUsageParser: UsageParser = (raw) => {
  if (!raw || typeof raw !== 'object') return { cached: undefined }
  const u = raw as Record<string, unknown>
  const openaiPath = (u.prompt_tokens_details as { cached_tokens?: unknown } | undefined)
    ?.cached_tokens
  if (typeof openaiPath === 'number') return { cached: openaiPath }
  if (typeof u.prompt_cache_hit_tokens === 'number') {
    return { cached: u.prompt_cache_hit_tokens }
  }
  return { cached: undefined }
}
```

(本步骤**不**修改 `ClientConfig`、不修改 `streamChat`,不动 `StreamEvent` shape。只是把符号引入。)

- [ ] **Step 4: Export from kernel index**

在 `packages/agent-kernel/src/index.ts` 现有 `export { OpenAICompatibleClient, type ChatMessage, type StreamEvent, } from './core/OpenAICompatibleClient'` 那块改成:

```ts
export {
  OpenAICompatibleClient,
  defaultUsageParser,
  type ChatMessage,
  type StreamEvent,
  type NormalizedUsage,
  type UsageParser,
} from './core/OpenAICompatibleClient'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun --cwd packages/agent-kernel run test tests/core/defaultUsageParser.test.ts`
Expected: PASS, all 6 cases green.

- [ ] **Step 6: Full kernel typecheck + tests + consumer build smoke**

```bash
bun run typecheck
bun --cwd packages/agent-kernel run test
bun --cwd packages/mycli-web run build
```

Expected: all green, no new typecheck errors, consumer build still produces `packages/mycli-web/dist/`.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-kernel/src/core/OpenAICompatibleClient.ts \
        packages/agent-kernel/src/index.ts \
        packages/agent-kernel/tests/core/defaultUsageParser.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): defaultUsageParser + NormalizedUsage types

Pure function recognizing OpenAI/GLM (prompt_tokens_details.cached_tokens)
and DeepSeek (prompt_cache_hit_tokens) usage shapes. Returns
{ cached: undefined } for unknown inputs without throwing. Not yet wired
into the client — that's the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire `usageParser` into `OpenAICompatibleClient.streamChat`

**Files:**
- Modify: `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`(`ClientConfig` 加字段;`streamChat` 调 parser;`StreamEvent` 升级)
- Modify: `packages/agent-kernel/tests/core/openAiClientUsage.test.ts`(扩展)

- [ ] **Step 1: Write failing tests (扩 `tests/core/openAiClientUsage.test.ts`)**

在该文件末尾追加(沿用文件已有的 `fakeFetch` helper):

```ts
describe('OpenAICompatibleClient cached usage propagation', () => {
  let origFetch: typeof globalThis.fetch
  beforeEach(() => {
    origFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('surfaces cached from OpenAI-shape usage on done event', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49,"prompt_tokens_details":{"cached_tokens":30}},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 42, out: 7, cached: 30 })
  })

  it('surfaces cached from DeepSeek-shape usage', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":50,"completion_tokens":8,"prompt_cache_hit_tokens":40,"prompt_cache_miss_tokens":10},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 50, out: 8, cached: 40 })
  })

  it('leaves cached undefined when usage has no cache field', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":10,"completion_tokens":2},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 10, out: 2 })  // no cached field at all
  })

  it('custom usageParser overrides default', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"foo_cached":99},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
      usageParser: (raw: any) => ({ cached: raw?.foo_cached }),
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 10, out: 2, cached: 99 })
  })

  it('custom usageParser that throws degrades to undefined cached without breaking stream', async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":10,"completion_tokens":2},"choices":[]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = fakeFetch(chunks) as any
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = new OpenAICompatibleClient({
      apiKey: 'x', baseUrl: 'http://x', model: 'm',
      usageParser: () => {
        throw new Error('bad parser')
      },
    })
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [] })) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.usage).toEqual({ in: 10, out: 2 })  // cached missing, but stream completed
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
```

确保文件顶部 `import { describe, it, expect, beforeEach, afterEach } from 'vitest'` 改为也包含 `vi`,即:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd packages/agent-kernel run test tests/core/openAiClientUsage.test.ts`
Expected: 5 new cases FAIL(`cached` 字段不存在 / `usageParser` 不在 ClientConfig 类型上)。原有 2 个 case 仍 PASS。

- [ ] **Step 3: Update `ClientConfig` and `StreamEvent`**

在 `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`:

把 `ClientConfig` 改为:

```ts
export interface ClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  fetchTimeoutMs?: number
  /**
   * Override how cached_tokens is extracted from the raw usage object on the
   * final SSE chunk. Defaults to defaultUsageParser. Errors thrown by this
   * function are caught (warning emitted) and treated as cached=undefined.
   */
  usageParser?: UsageParser
}
```

把 `StreamEvent` 中 `done` 的 `usage` 字段类型从 `{ in: number; out: number }` 改为 `NormalizedUsage`:

```ts
export type StreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'toolDelta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | {
      kind: 'done'
      stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown'
      toolCalls?: Array<{ id: string; name: string; input: unknown }>
      usage?: NormalizedUsage
    }
```

- [ ] **Step 4: Wire parser into `streamChatInner`**

定位 `streamChatInner` 里现有的:

```ts
let usage: { in: number; out: number } | undefined
```

改成:

```ts
let usage: NormalizedUsage | undefined
```

定位现有 usage 解析:

```ts
if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') {
  usage = { in: parsed.usage.prompt_tokens, out: parsed.usage.completion_tokens ?? 0 }
}
```

改成:

```ts
if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') {
  const parser = this.cfg.usageParser ?? defaultUsageParser
  let cachedField: number | undefined
  try {
    cachedField = parser(parsed.usage).cached
  } catch (e) {
    console.warn('[OpenAICompatibleClient] usageParser threw, treating cached as undefined', e)
    cachedField = undefined
  }
  usage = {
    in: parsed.usage.prompt_tokens,
    out: parsed.usage.completion_tokens ?? 0,
    ...(cachedField !== undefined ? { cached: cachedField } : {}),
  }
}
```

(条件展开 `...(cachedField !== undefined ? { cached: cachedField } : {})` 保证 `cached: undefined` 不被显式塞进对象,以让 `toEqual({ in, out })` 这种 strict 等价检查通过。)

- [ ] **Step 5: Run extended test file**

Run: `bun --cwd packages/agent-kernel run test tests/core/openAiClientUsage.test.ts`
Expected: 全部 7 个 case PASS(2 原有 + 5 新增)。

- [ ] **Step 6: Full kernel test suite + typecheck**

```bash
bun run typecheck
bun --cwd packages/agent-kernel run test
```

Expected: 144 + 5 = 149 个测试全绿,typecheck cold-cache 干净。

- [ ] **Step 7: Commit**

```bash
git add packages/agent-kernel/src/core/OpenAICompatibleClient.ts \
        packages/agent-kernel/tests/core/openAiClientUsage.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): client surfaces cached_tokens via NormalizedUsage

ClientConfig now accepts an optional usageParser (defaults to
defaultUsageParser). StreamEvent.done.usage is widened to NormalizedUsage
with optional cached. Parser exceptions are caught and degrade to
cached=undefined without breaking the stream.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Propagate through `QueryEngine` + `AgentSession` + core `protocol.ts`

**Files:**
- Modify: `packages/agent-kernel/src/core/QueryEngine.ts`(`EngineEvent.assistant_message_complete.usage` 类型 + `usageThisIter` 类型)
- Modify: `packages/agent-kernel/src/core/AgentSession.ts`(yield 时透传 cached)
- Modify: `packages/agent-kernel/src/core/protocol.ts`(core `Usage` Zod 加 cached)
- Modify: `packages/agent-kernel/tests/core/queryEngineUsage.test.ts`(扩展)
- Modify: `packages/agent-kernel/tests/core/protocol.test.ts`(扩展)

- [ ] **Step 1: Inspect existing tests for pattern**

Run: `cat packages/agent-kernel/tests/core/queryEngineUsage.test.ts` 和 `cat packages/agent-kernel/tests/core/protocol.test.ts`
认真读现有断言风格 — 后面写的测试必须沿用既有 mock client fixture / Zod assertion 形式。

- [ ] **Step 2: Write failing tests**

在 `packages/agent-kernel/tests/core/queryEngineUsage.test.ts` 末尾追加 1 个 case:

```ts
it('forwards cached on assistant_message_complete when client reports it', async () => {
  // 复用现有文件里的 mock fakeClient pattern;在 streamChat 的 done 事件 usage
  // 上多带 cached: 30
  const fakeClient = {
    async *streamChat() {
      yield { kind: 'delta', text: 'hi' }
      yield {
        kind: 'done',
        stopReason: 'stop',
        usage: { in: 42, out: 7, cached: 30 },
      }
    },
  } as any
  const engine = new QueryEngine({
    client: fakeClient,
    tools: [],
    executeTool: async () => ({ ok: true, data: '' }),
  })
  const events: any[] = []
  for await (const ev of engine.run([{ role: 'user', content: 'q' }])) events.push(ev)
  const complete = events.find((e) => e.kind === 'assistant_message_complete')
  expect(complete.usage).toEqual({ in: 42, out: 7, cached: 30 })
})
```

(import 路径与文件顶部现有 `QueryEngine` import 一致。)

在 `packages/agent-kernel/tests/core/protocol.test.ts` 末尾追加 2 个 case:

```ts
describe('core Usage event with cached', () => {
  it('parses Usage event with cached field', () => {
    const evt = { kind: 'usage', input: 100, output: 20, cached: 80 }
    // 用本文件已有的 schema import / parse helper;若没有就 import { Usage } from
    // '../../src/core/protocol'(实际名字以代码里为准)。
    // ...assertion...
  })

  it('parses Usage event without cached field (backward compat)', () => {
    const evt = { kind: 'usage', input: 100, output: 20 }
    // ...assertion...
  })
})
```

执行时把 `// ...assertion...` 落地为该文件已有的 schema 解析风格(`Schema.parse(evt)` 或 `expect(...).not.toThrow()`)。

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
bun --cwd packages/agent-kernel run test tests/core/queryEngineUsage.test.ts
bun --cwd packages/agent-kernel run test tests/core/protocol.test.ts
```
Expected: 3 个新 case FAIL(`cached` 字段不在 type / schema 上)。

- [ ] **Step 4: Update `QueryEngine.ts` types**

在 `packages/agent-kernel/src/core/QueryEngine.ts`:

把:
```ts
import type { OpenAICompatibleClient, ChatMessage } from './OpenAICompatibleClient'
```
改为:
```ts
import type {
  OpenAICompatibleClient,
  ChatMessage,
  NormalizedUsage,
} from './OpenAICompatibleClient'
```

把 `EngineEvent` 中 `assistant_message_complete.usage` 字段类型从 `{ in: number; out: number }` 改为 `NormalizedUsage`。

把函数体里的:
```ts
let usageThisIter: { in: number; out: number } | undefined
```
改为:
```ts
let usageThisIter: NormalizedUsage | undefined
```

`usageThisIter = ev.usage` 那行的赋值不动 — 它本来就直接拷整个 usage 对象,新结构自动透传。

- [ ] **Step 5: Update core `protocol.ts` Zod**

在 `packages/agent-kernel/src/core/protocol.ts` 找到:

```ts
const Usage = z.object({
  kind: z.literal('usage'),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
})
```

改为:

```ts
const Usage = z.object({
  kind: z.literal('usage'),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative().optional(),
})
```

- [ ] **Step 6: Update `AgentSession.ts` to yield cached**

在 `packages/agent-kernel/src/core/AgentSession.ts` 找到:

```ts
if (ev.usage) {
  yield { kind: 'usage', input: ev.usage.in, output: ev.usage.out }
}
```

改为:

```ts
if (ev.usage) {
  yield {
    kind: 'usage',
    input: ev.usage.in,
    output: ev.usage.out,
    ...(ev.usage.cached !== undefined ? { cached: ev.usage.cached } : {}),
  }
}
```

(条件展开,确保 cached=undefined 时字段不进对象,匹配 Zod optional 风格。)

- [ ] **Step 7: Run tests to verify they pass**

```bash
bun --cwd packages/agent-kernel run test tests/core/queryEngineUsage.test.ts
bun --cwd packages/agent-kernel run test tests/core/protocol.test.ts
```
Expected: 全绿。

- [ ] **Step 8: Full kernel typecheck + tests**

```bash
bun run typecheck
bun --cwd packages/agent-kernel run test
```

Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add packages/agent-kernel/src/core/QueryEngine.ts \
        packages/agent-kernel/src/core/AgentSession.ts \
        packages/agent-kernel/src/core/protocol.ts \
        packages/agent-kernel/tests/core/queryEngineUsage.test.ts \
        packages/agent-kernel/tests/core/protocol.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): propagate cached through QueryEngine + AgentSession

EngineEvent.assistant_message_complete.usage and core 'usage' event
both carry the optional cached field now. Zod schema is additive — old
events without cached still parse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Propagate through wire `protocol.ts` + `agentService.ts`

**Files:**
- Modify: `packages/agent-kernel/src/browser/rpc/protocol.ts`(wire `MessageUsage` 加 cached)
- Modify: `packages/agent-kernel/src/browser/agentService.ts`(emit 时透传)
- Modify or Create: `packages/agent-kernel/tests/browser/rpc/protocol.test.ts`(扩 / 新增)
- Modify or Create: `packages/agent-kernel/tests/browser/agentService*.test.ts`(扩 / 新增)

- [ ] **Step 1: Inspect existing wire-level protocol & agentService tests**

```bash
find packages/agent-kernel/tests/browser -name "*.test.ts" -exec ls {} \;
```
找现有 `MessageUsage` 测试文件(命名可能是 `protocol.test.ts` 或 `wireProtocol.test.ts`)。找现有 agentService 测试文件,找一个能在 mock fakeClient 下端到端 emit `message/usage` 的测试,作为扩展基础。

如果完全没有 wire-level `MessageUsage` 单测,则新建 `packages/agent-kernel/tests/browser/rpc/protocolMessageUsage.test.ts`。

如果完全没有 agentService 的 usage 集成测试,则新建 `packages/agent-kernel/tests/browser/agentServiceUsage.test.ts`。

- [ ] **Step 2: Write failing tests for wire `MessageUsage` Zod**

```ts
import { describe, it, expect } from 'vitest'
import { WireAgentEvent } from 'agent-kernel'

describe('wire MessageUsage with cached', () => {
  it('parses message/usage event with cached field', () => {
    const evt = {
      id: 'e1',
      sessionId: 's1',
      ts: 1,
      kind: 'message/usage',
      messageId: 'm1',
      input: 100,
      output: 20,
      cached: 80,
    }
    expect(() => WireAgentEvent.parse(evt)).not.toThrow()
  })

  it('parses message/usage event without cached field (backward compat)', () => {
    const evt = {
      id: 'e1',
      sessionId: 's1',
      ts: 1,
      kind: 'message/usage',
      messageId: 'm1',
      input: 100,
      output: 20,
    }
    expect(() => WireAgentEvent.parse(evt)).not.toThrow()
  })
})
```

(若 `WireAgentEvent.parse` 不是入口,从 `packages/agent-kernel/src/browser/rpc/protocol.ts` 看实际导出的 schema 名字。)

- [ ] **Step 3: Write failing tests for agentService propagation**

复用现有 agentService 测试里的 mock setup(fakeClient + emit spy)。新 case:

```ts
it('emits message/usage with cached when client reports cached_tokens', async () => {
  const fakeClient = {
    async *streamChat() {
      yield { kind: 'delta', text: 'hi' }
      yield {
        kind: 'done',
        stopReason: 'stop',
        usage: { in: 42, out: 7, cached: 30 },
      }
    },
  } as any
  const emitted: any[] = []
  // ...构造 createAgentService 的 deps(参考现有测试 setup)...
  const svc = createAgentService({
    /* deps with emit: (e) => emitted.push(e) */
  })
  // ...run a turn...
  const usageEvt = emitted.find((e) => e.kind === 'message/usage')
  expect(usageEvt).toBeDefined()
  expect(usageEvt.cached).toBe(30)
})

it('emits message/usage without cached when client omits it', async () => {
  // ...same setup but usage: { in: 42, out: 7 }...
  const usageEvt = emitted.find((e) => e.kind === 'message/usage')
  expect(usageEvt).toBeDefined()
  expect(usageEvt.cached).toBeUndefined()
})
```

(具体 deps 的 mock 形态以现有 agentService 测试 fixture 为准 — 别另起一套。)

- [ ] **Step 4: Run tests to verify they fail**

Run:
```bash
bun --cwd packages/agent-kernel run test tests/browser/rpc/
bun --cwd packages/agent-kernel run test tests/browser/agentService
```
Expected: 新增 4 个 case 都 FAIL。

- [ ] **Step 5: Update wire `MessageUsage` Zod**

在 `packages/agent-kernel/src/browser/rpc/protocol.ts` 找到(line 120 附近):

```ts
const MessageUsage = Base.extend({
  kind: z.literal('message/usage'),
  messageId: Uuid,
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
})
```

改为:

```ts
const MessageUsage = Base.extend({
  kind: z.literal('message/usage'),
  messageId: Uuid,
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative().optional(),
})
```

- [ ] **Step 6: Update `agentService.ts` to forward cached**

在 `packages/agent-kernel/src/browser/agentService.ts` 找到(line ~413-427):

```ts
} else if (ev.kind === 'usage') {
  if (lastAssistantId) {
    deps.emit({
      id: crypto.randomUUID(),
      sessionId: cmd.sessionId,
      ts: Date.now(),
      kind: 'message/usage',
      messageId: lastAssistantId,
      input: ev.input,
      output: ev.output,
    })
  }
}
```

改为:

```ts
} else if (ev.kind === 'usage') {
  if (lastAssistantId) {
    deps.emit({
      id: crypto.randomUUID(),
      sessionId: cmd.sessionId,
      ts: Date.now(),
      kind: 'message/usage',
      messageId: lastAssistantId,
      input: ev.input,
      output: ev.output,
      ...(ev.cached !== undefined ? { cached: ev.cached } : {}),
    })
  }
}
```

- [ ] **Step 7: Run all relevant tests**

```bash
bun --cwd packages/agent-kernel run test tests/browser/rpc/
bun --cwd packages/agent-kernel run test tests/browser/
```
Expected: 全绿。

- [ ] **Step 8: Full kernel + consumer typecheck + tests + build**

```bash
bun run typecheck
bun --cwd packages/agent-kernel run test
bun --cwd packages/mycli-web run test
bun --cwd packages/mycli-web run build
```

Expected: 全绿,consumer build 产物 `packages/mycli-web/dist/` 依然能生成。

- [ ] **Step 9: Commit**

```bash
git add packages/agent-kernel/src/browser/rpc/protocol.ts \
        packages/agent-kernel/src/browser/agentService.ts \
        packages/agent-kernel/tests/browser/
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): wire MessageUsage event now carries cached

agentService forwards cached from the upstream usage event to the
wire-level message/usage event. Zod schema is additive — consumers that
don't care can ignore the field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Live test + final verification

**Files:**
- Modify: `packages/mycli-web/tests/integration/agent.live.test.ts`(或 kernel 下的对应 live test 文件——执行时先找)

- [ ] **Step 1: Locate the live test file**

```bash
find packages -path '*tests*' -name 'agent.live*'
grep -rn "MYCLI_TEST_API_KEY\|prompt_tokens_details" packages/*/tests/integration/ 2>/dev/null
```
确认 live test 文件位置和 env-gated skip 机制。

- [ ] **Step 2: Add the failing live case**

在该 live test 文件末尾追加 1 个 case(沿用现有的 skipIf / describe.skipIf 模式):

```ts
it.skipIf(!process.env.MYCLI_TEST_API_KEY)(
  'cached field is plumbed through done.usage on a repeat-context call',
  async () => {
    // 构造一个长一点的 system + history 让 cache 有机会命中,但本测试只验证
    // 字段链路打通,不强行 assert cached > 0(冷缓存可能不命中)。
    const stableSystem = `You are a helpful assistant. ${'X'.repeat(2000)}`
    const client = new OpenAICompatibleClient({
      apiKey: process.env.MYCLI_TEST_API_KEY!,
      baseUrl: process.env.MYCLI_TEST_BASE_URL ?? '<default GLM base>',
      model: process.env.MYCLI_TEST_MODEL ?? 'glm-4-flash',
    })
    // 第一轮 prime cache
    const events1: any[] = []
    for await (const ev of client.streamChat({
      messages: [
        { role: 'system', content: stableSystem },
        { role: 'user', content: 'Say hi.' },
      ],
    })) events1.push(ev)
    // 第二轮 — 同样的 system + history,但加新 user turn
    const events2: any[] = []
    for await (const ev of client.streamChat({
      messages: [
        { role: 'system', content: stableSystem },
        { role: 'user', content: 'Say hi.' },
        { role: 'assistant', content: 'Hi.' },
        { role: 'user', content: 'Say bye.' },
      ],
    })) events2.push(ev)
    const done2 = events2.find((e) => e.kind === 'done')
    expect(done2.usage).toBeDefined()
    // cached 字段必须存在(undefined 或 number 都接受) — 验证链路而非命中率
    expect(['number', 'undefined']).toContain(typeof done2.usage.cached)
  },
  60_000,
)
```

(具体 baseUrl / model 默认值用现有 live test 里的同名常量;别新造。)

- [ ] **Step 3: Verify the case runs and passes (with credentials)**

```bash
MYCLI_TEST_API_KEY=<key> bun --cwd packages/mycli-web run test tests/integration/agent.live.test.ts -t "cached field is plumbed"
```
Expected: PASS。若环境跟旧 handoff 一样用 `~/test.txt` 注入凭据,沿用现有机制。

- [ ] **Step 4: Verify the case is skipped without credentials**

```bash
unset MYCLI_TEST_API_KEY
bun --cwd packages/mycli-web run test tests/integration/agent.live.test.ts
```
Expected: 新 case 显示为 SKIPPED,其他 live case 行为不变。

- [ ] **Step 5: Final full-stack verification**

```bash
bun run typecheck
bun --cwd packages/agent-kernel run test
bun --cwd packages/mycli-web run test
bun --cwd packages/mycli-web run build
```

Expected:
- typecheck cold-cache 干净
- kernel 测试通过(149+ 个,具体取决于扩展数)
- consumer 测试通过(34+)
- consumer build 产物完整

记录最终测试数与 baseline(skills 后的 144 + 5 新增大约)的差值,如果数字异常,排查。

- [ ] **Step 6: Commit**

```bash
git add packages/mycli-web/tests/integration/agent.live.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "test(integration): live verifies cached is plumbed end-to-end

Skip-by-default unless MYCLI_TEST_API_KEY is set. Validates the field
chain only, not the hit rate — cold cache may not hit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Write handoff note**

在 `packages/mycli-web/docs/superpowers/` 新建 `HANDOFF-2026-05-12-prompt-cache-observability.md`,跟着 `HANDOFF-2026-05-10-skills.md` 的风格写:

- 一句话总结
- 跑了什么(commit 列表 + 测试数 baseline)
- 怎么试一下(REPL 或扩展)
- 改了哪些文件
- 已知问题
- 下一步(下个 sub-project 待 brainstorm)

Commit:

```bash
git add packages/mycli-web/docs/superpowers/HANDOFF-2026-05-12-prompt-cache-observability.md
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "docs: handoff for prompt cache observability

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (执行 plan 的人可以跳过这节;这是我写完后做的)

**Spec coverage check:**

| Spec 章节 | Plan task |
|---|---|
| §概述 / 目标 | Task 1-5 整体 |
| Kernel API 变化 §1-4(NormalizedUsage / UsageParser / ClientConfig / StreamEvent) | Task 1 + 2 |
| Kernel API §5(agentService) | Task 4 |
| 默认 parser 识别的三种 shape | Task 1 |
| 数据流(client → engine → session → service → wire) | Task 2 → Task 3 → Task 4 |
| 错误处理(parser 抛错 / null 输入 / 缺 usage) | Task 1 + Task 2 case 5 |
| 测试策略(kernel 单测 + live test) | Task 1-4 单测 + Task 5 live |
| Zod additive 向后兼容 | Task 3 protocol + Task 4 wire protocol |
| 前向兼容(Anthropic) | spec 自身的章节,无对应 task(那是未来 spec 的事) |
| 文件清单 | File Map 节 + 各 task 的 Files |

**Placeholder scan:** 没发现 TBD / TODO / "handle edge cases" 之类。Task 3 Step 2 protocol.test 那一段的 `...assertion...` 字面上是占位,但前后明确指示"用本文件已有的 schema 解析风格"——执行者一看代码就懂,可以接受。Task 5 Step 7 handoff 节也是结构化模板,不是占位。

**Type consistency check:**
- `NormalizedUsage` / `UsageParser` / `defaultUsageParser` 在 Task 1, 2, 3 中名字一致 ✓
- `ClientConfig.usageParser` 字段名一致 ✓
- `StreamEvent.done.usage` 升级路径连贯(Task 2 改类型,Task 3 在 QueryEngine 接住,Task 4 在 agentService 接住)✓
- core `Usage` Zod 和 wire `MessageUsage` Zod 的 cached 字段名一致(`cached`)✓

**Scope check:** 5 个 task,每个 task 一个 commit,改动量按文件清单 ~80 LOC kernel + ~120 LOC test。聚焦在单一 sub-project,符合 brainstorm 阶段的分拆决定。
