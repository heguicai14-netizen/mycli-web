# mycli-web Plan B — Agent 核心 + 读工具 + 最小聊天 UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让 mycli-web 浮窗里的对话真的能跑通端到端：用户输入 → LLM 流式回复 → 渲染 → 包含 6 个读工具（readPage / readSelection / querySelector / screenshot / listTabs / fetch GET）让 agent 能回答"这页讲什么 / 帮我提取这块内容 / 抓取那个 URL 的 JSON"等典型问题。

**Architecture:** 在 Plan A 的 RPC/存储/UI 骨架上：（1）新写一个**最小化** agent 核心（不照搬 mycli 5000 行 TUI 耦合代码），实现 OpenAI-compatible 流式客户端 + 工具协议 + agent 循环；（2）实现 6 个读工具，分为 content-script 侧 DOM 操作 + offscreen 侧网络/Chrome API 操作；（3）把 SW hub 从 echo 模式切换到 offscreen-forward 转发；（4）offscreen 作为 agent runtime，订阅 SW 转发的命令、跑 QueryEngine、广播 AgentEvent；（5）替换 Plan A 的 ChatShell 占位为真实的 React 聊天 UI（消息列表 + 输入框 + 工具调用卡片 + 会话列表）。

**Tech Stack:** 沿用 Plan A 全部依赖；本 plan 不引入新 npm 依赖（fetch / SSE 解析全用浏览器原生 API）。

**Prerequisites:** Plan A 完成。`mycli-web/` 在 git main 分支两个 commit 上（`bd79dc1`、`f4fd353`）；43 测试绿；`bun run build` 产出可加载 dist/；用户已在 Chrome 里手工烟测确认 FAB / ChatShell / Options 都工作。

**关键设计决策（本 plan 锁定）：**

1. **不**直接移植 mycli 的 QueryEngine.ts (1295 行) / query.ts (1729 行)。它们重度耦合 Ink TUI、stdin TTY 控制、订阅限流等。本 plan 写一份 ~250 行的全新最小 QueryEngine，采纳 mycli 的循环结构（user → LLM → tools → LLM → ... 直到 stop）但去掉所有 TUI 钩子。
2. **不**移植 mycli 的 openaiCompatibleClient.ts (867 行)。该文件用 axios + 复杂 retry/proxy/telemetry 装饰器。本 plan 写一份 ~150 行直接用浏览器原生 `fetch` + SSE `ReadableStream` 的精简实现。
3. **不**移植 mycli 的 Tool.ts (792 行)。它含 Ink 渲染钩子、yoga layout、CLI render path。本 plan 写一份 ~80 行的纯协议契约（schema + execute 函数），UI 渲染独立放在 React 组件里。
4. 工具调用模型：**先 LLM 输出完整工具调用 JSON → 串行执行 → 把结果作为新的 message 喂给下一轮 LLM**。不做并行工具、不做 streaming partial tool calls（OpenAI tool_calls 协议本身允许，但 Plan B 串行处理够用）。
5. `chat/send` 不阻塞返回——offscreen 立即 `command/ack` 然后异步驱动 LLM 循环、用 `AgentEvent` 流推送增量。
6. 暂不做：**子 agent / 压缩 / 停止钩子框架 / skills / 写工具 / 审批 UI**——全部留给 Plan C-F。`toolMaxIterations`（默认 50）作为唯一的硬停止条件先实现进 QueryEngine。
7. 单会话模式起步——浮窗只显示当前会话；ConversationList 完整 UI 留 Plan B-tail 或后续小 patch。**会话切换**只通过 options 页"清空所有对话"按钮（Plan A 已埋）+ "新建会话"按钮（本 plan 加）实现，不做完整的多会话 picker。

**File Structure（Plan B 新增/修改）：**

```
mycli-web/
├── src/
│   ├── agent/                          # 🆕 整个 agent 核心
│   │   ├── Tool.ts                     # 工具协议（schema + execute 签名）
│   │   ├── api/
│   │   │   └── openaiCompatibleClient.ts  # 流式 LLM 客户端
│   │   └── query/
│   │       ├── QueryEngine.ts          # agent 循环
│   │       └── tokenBudget.ts          # 简单 token 估算（GPT-4 tokenizer 近似）
│   ├── tools/                          # 🆕 浏览器工具实现
│   │   ├── registry.ts                 # 工具注册表
│   │   ├── readPage.ts
│   │   ├── readSelection.ts
│   │   ├── querySelector.ts
│   │   ├── screenshot.ts
│   │   ├── listTabs.ts
│   │   └── fetchGet.ts
│   ├── extension/
│   │   ├── background.ts               # ✏️ 切 hub 到 offscreen-forward 模式
│   │   ├── offscreen.ts                # ✏️ 真正的 agent runtime
│   │   ├── content/
│   │   │   ├── index.tsx               # ✏️ 替换 ChatShell 占位为 ChatApp
│   │   │   ├── domHandlers.ts          # 🆕 处理 SW → CS 的 DOM op 消息
│   │   │   └── ChatApp.tsx             # 🆕 主应用组件
│   │   ├── ui/                         # 🆕 React 聊天 UI
│   │   │   ├── ChatWindow.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── Composer.tsx
│   │   │   └── ConversationHeader.tsx
│   │   └── rpc/
│   │       └── hub.ts                  # ✏️ 加 offscreen-forward 转发逻辑
│   └── shared/
│       └── types.ts                    # ✏️ 补 AssistantMessage / ToolCall 等
└── tests/
    ├── agent/
    │   ├── openaiCompatibleClient.test.ts
    │   ├── QueryEngine.test.ts
    │   └── tokenBudget.test.ts
    ├── tools/
    │   ├── registry.test.ts
    │   ├── readPage.test.ts
    │   └── fetchGet.test.ts
    └── rpc/
        └── hub-forward.test.ts         # 验证 offscreen-forward 模式
```

**目标测试规模：** ~25 条新测试，加 Plan A 的 43 = ~68 总。

---

## Section 1 — 共享类型补齐

### Task 1: 补 AssistantMessage / ToolCall / UserMessage / ContentPart

**Files:**
- Modify: `mycli-web/src/shared/types.ts`

- [ ] **Step 1: Read current shared/types.ts**

```bash
cat /Users/heguicai/myProject/mycli-web/src/shared/types.ts
```

- [ ] **Step 2: 追加新类型**

把以下追加到 `src/shared/types.ts` 末尾：
```ts
// ---------------- Agent message types ----------------

/** 一段消息内容；MVP 仅支持纯文本，后续可扩 image / file / tool_use 等 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: ToolCallId; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: ToolCallId; content: string; is_error?: boolean }

export interface UserMessage {
  id: MessageId
  role: 'user'
  content: ContentPart[]
  createdAt: number
}

export interface AssistantMessage {
  id: MessageId
  role: 'assistant'
  content: ContentPart[]
  createdAt: number
  /** 中间态 streaming 时为 true，完成后置 false */
  pending?: boolean
  /** LLM finish reason */
  stopReason?: 'end_turn' | 'tool_use' | 'max_iterations' | 'cancel' | 'error'
}

export interface ToolMessage {
  id: MessageId
  role: 'tool'
  toolCallId: ToolCallId
  content: string
  isError?: boolean
  createdAt: number
}

export type Message = UserMessage | AssistantMessage | ToolMessage

export interface ToolCall {
  id: ToolCallId
  name: string
  input: unknown
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema
  /** Where the tool's body actually runs */
  exec: 'content' | 'sw' | 'offscreen'
  execute(input: I, ctx: ToolExecContext): Promise<ToolResult<O>>
}

export interface ToolExecContext {
  conversationId: ConversationId
  /** Active tab id (the one user invoked agent on) */
  tabId: number | undefined
  /** RPC client to send DomOp / Chrome API requests via SW */
  rpc: ToolExecRpc
}

export interface ToolExecRpc {
  /** Send a DomOp to the target tab's content script and await response */
  domOp(op: unknown, timeoutMs?: number): Promise<ToolResult>
  /** Invoke a chrome.* API via SW */
  chromeApi(method: string, args: unknown[]): Promise<ToolResult>
}
```

- [ ] **Step 3: 跑 typecheck**

```bash
cd /Users/heguicai/myProject/mycli-web && bun run typecheck
```
预期：无错误（这些都是新类型，不影响现有代码）。

---

## Section 2 — OpenAI-compatible 客户端

### Task 2: 写 LLM 客户端（流式 fetch + SSE 解析）

**Files:**
- Create: `src/agent/api/openaiCompatibleClient.ts`
- Create: `tests/agent/openaiCompatibleClient.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/agent/openaiCompatibleClient.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleClient } from '@/agent/api/openaiCompatibleClient'

const baseConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.test/v1',
  model: 'gpt-4o-mini',
}

function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('OpenAICompatibleClient.streamChat', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses SSE chunks into incremental text deltas', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n'
    ;(fetch as any).mockResolvedValue(makeStreamResponse([sse]))
    const client = new OpenAICompatibleClient(baseConfig)
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev)
    }
    const deltas = events.filter((e) => e.kind === 'delta').map((e) => e.text).join('')
    expect(deltas).toBe('Hello world')
    expect(events.some((e) => e.kind === 'done' && e.stopReason === 'stop')).toBe(true)
  })

  it('parses tool_calls in the stream', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"readPage","arguments":""}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"mode\\":\\"text\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n'
    ;(fetch as any).mockResolvedValue(makeStreamResponse([sse]))
    const client = new OpenAICompatibleClient(baseConfig)
    const events: any[] = []
    for await (const ev of client.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev)
    }
    const done = events.find((e) => e.kind === 'done')
    expect(done?.stopReason).toBe('tool_calls')
    expect(done?.toolCalls).toEqual([{ id: 'call_1', name: 'readPage', input: { mode: 'text' } }])
  })

  it('throws structured error on 401', async () => {
    ;(fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid_api_key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = new OpenAICompatibleClient(baseConfig)
    const fn = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.streamChat({ messages: [] })) {
        /* drain */
      }
    }
    await expect(fn()).rejects.toMatchObject({ status: 401 })
  })

  it('respects abort signal', async () => {
    const abort = new AbortController()
    const sse = 'data: {"choices":[{"delta":{"content":"slow"}}]}\n\n'
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
        // Don't close — hang
      },
      cancel() {
        cancelled = true
      },
    })
    ;(fetch as any).mockResolvedValue(new Response(stream, { status: 200 }))
    const client = new OpenAICompatibleClient(baseConfig)
    const iter = client.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      signal: abort.signal,
    })
    const collected: any[] = []
    const collector = (async () => {
      try {
        for await (const ev of iter) collected.push(ev)
      } catch (e) {
        // expected
      }
    })()
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await collector
    expect(cancelled).toBe(true)
  })
})
```

跑 `bun run test -- openaiCompatibleClient`，确认红。

- [ ] **Step 2: 实现 client**

`src/agent/api/openaiCompatibleClient.ts`：
```ts
export interface ClientConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  name?: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  signal?: AbortSignal
}

export type StreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'toolDelta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | {
      kind: 'done'
      stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown'
      toolCalls?: Array<{ id: string; name: string; input: unknown }>
    }

export class OpenAICompatibleClient {
  constructor(private cfg: ClientConfig) {}

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      stream: true,
      messages: req.messages,
    }
    if (req.tools && req.tools.length) body.tools = req.tools
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!res.ok) {
      let detail: unknown = undefined
      try {
        detail = await res.json()
      } catch {
        try {
          detail = await res.text()
        } catch {
          /* ignore */
        }
      }
      throw Object.assign(new Error(`LLM HTTP ${res.status}`), { status: res.status, detail })
    }
    if (!res.body) throw new Error('no response body')

    // Accumulator for tool_calls — OpenAI streams them in pieces by index.
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason: string | undefined

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const line = event.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          finishReason = finishReason ?? 'stop'
          continue
        }
        let parsed: any
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        const choice = parsed?.choices?.[0]
        if (!choice) continue
        if (choice.delta?.content) {
          yield { kind: 'delta', text: choice.delta.content }
        }
        if (Array.isArray(choice.delta?.tool_calls)) {
          for (const tc of choice.delta.tool_calls) {
            const i = tc.index ?? 0
            const existing = toolAcc.get(i) ?? { id: '', name: '', arguments: '' }
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.name = tc.function.name
            if (typeof tc.function?.arguments === 'string') existing.arguments += tc.function.arguments
            toolAcc.set(i, existing)
            yield {
              kind: 'toolDelta',
              index: i,
              id: tc.id,
              name: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    }

    const stopReason: StreamEvent & { kind: 'done' } = (() => {
      const sr = (finishReason ?? 'stop') as 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown'
      const known: Record<string, true> = { stop: true, tool_calls: true, length: true, content_filter: true }
      const reason = known[sr] ? sr : 'unknown'
      const tcs = Array.from(toolAcc.values())
        .map((t) => {
          let input: unknown = {}
          try {
            input = t.arguments ? JSON.parse(t.arguments) : {}
          } catch {
            input = { _rawArguments: t.arguments }
          }
          return { id: t.id || crypto.randomUUID(), name: t.name, input }
        })
      return { kind: 'done', stopReason: reason, toolCalls: tcs.length ? tcs : undefined }
    })()
    yield stopReason
  }
}
```

跑 `bun run test -- openaiCompatibleClient`，预期 4 条全绿。

---

## Section 3 — 工具协议 + 注册表

### Task 3: 工具协议契约

**Files:**
- Create: `src/agent/Tool.ts`

- [ ] **Step 1: 写 Tool.ts**

`src/agent/Tool.ts`：
```ts
import type { ToolDefinition, ToolResult } from '@shared/types'

export type { ToolDefinition, ToolResult } from '@shared/types'

/** Convert a ToolDefinition to OpenAI tools[] entry */
export function toOpenAiTool(def: ToolDefinition): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
} {
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters: def.inputSchema },
  }
}

export function makeError(code: string, message: string, retryable = false): ToolResult {
  return { ok: false, error: { code, message, retryable } }
}

export function makeOk<T>(data: T): ToolResult<T> {
  return { ok: true, data }
}
```

### Task 4: 工具注册表

**Files:**
- Create: `src/tools/registry.ts`
- Create: `tests/tools/registry.test.ts`

- [ ] **Step 1: 写测试（红）**

`tests/tools/registry.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '@/tools/registry'
import type { ToolDefinition } from '@shared/types'

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
```

跑确认红。

- [ ] **Step 2: 实现**

`src/tools/registry.ts`：
```ts
import { toOpenAiTool } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

export class ToolRegistry {
  private map = new Map<string, ToolDefinition>()

  register(def: ToolDefinition): void {
    if (this.map.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`)
    this.map.set(def.name, def)
  }

  get(name: string): ToolDefinition | undefined {
    return this.map.get(name)
  }

  all(): ToolDefinition[] {
    return Array.from(this.map.values())
  }

  toOpenAi() {
    return this.all().map(toOpenAiTool)
  }
}
```

跑 `bun run test -- tools/registry`，预期 4 绿。

---

## Section 4 — 浏览器读工具

### Task 5: readPage（content-script 侧执行）

**Files:**
- Create: `src/tools/readPage.ts`
- Create: `tests/tools/readPage.test.ts`

readPage 的执行模型：
- offscreen 调 `ctx.rpc.domOp({ kind: 'dom/readPage', tabId, mode })` → SW 转发到 tab 的 content script → content script 读取 DOM → 返回 → offscreen 拿到结果

工具定义本身住在 offscreen 注册表里，但它的"执行体"是发起 RPC 调用。

- [ ] **Step 1: 写测试（mock ctx.rpc）**

`tests/tools/readPage.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { readPageTool } from '@/tools/readPage'
import type { ToolExecContext } from '@shared/types'

function makeCtx(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    conversationId: 'conv1',
    tabId: 42,
    rpc: {
      domOp: vi.fn().mockResolvedValue({ ok: true, data: { text: 'hello world' } }),
      chromeApi: vi.fn(),
    },
    ...overrides,
  }
}

describe('readPage tool', () => {
  it('returns ok with page text', async () => {
    const ctx = makeCtx()
    const result = await readPageTool.execute({ mode: 'text' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.text).toBe('hello world')
    expect(ctx.rpc.domOp).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dom/readPage', tabId: 42, mode: 'text' }),
      expect.any(Number),
    )
  })

  it('errors when no tabId in context', async () => {
    const ctx = makeCtx({ tabId: undefined })
    const result = await readPageTool.execute({ mode: 'text' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('no_active_tab')
  })

  it('defaults mode to text when not provided', async () => {
    const ctx = makeCtx()
    await readPageTool.execute({}, ctx)
    expect(ctx.rpc.domOp).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'text' }),
      expect.any(Number),
    )
  })
})
```

- [ ] **Step 2: 实现 readPage**

`src/tools/readPage.ts`：
```ts
import { makeError } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

interface ReadPageInput {
  mode?: 'text' | 'markdown' | 'html-simplified'
}

interface ReadPageOutput {
  text: string
  url?: string
  title?: string
}

export const readPageTool: ToolDefinition<ReadPageInput, ReadPageOutput> = {
  name: 'readPage',
  description: 'Read the current page content as text, markdown, or simplified HTML.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['text', 'markdown', 'html-simplified'],
        default: 'text',
      },
    },
  },
  exec: 'content',
  async execute(input, ctx) {
    if (ctx.tabId === undefined) {
      return makeError('no_active_tab', 'no active tab to read from')
    }
    const mode = input.mode ?? 'text'
    const result = await ctx.rpc.domOp({ kind: 'dom/readPage', tabId: ctx.tabId, mode }, 30_000)
    return result as any
  },
}
```

跑 `bun run test -- tools/readPage`，预期 3 绿。

### Task 6: readSelection / querySelector / screenshot / listTabs / fetchGet

写 5 个工具的实现。模式与 readPage 类似——offscreen 侧定义工具、execute 转发 DomOp 或 ChromeApi 调用。

**Files:**
- Create: `src/tools/readSelection.ts`
- Create: `src/tools/querySelector.ts`
- Create: `src/tools/screenshot.ts`
- Create: `src/tools/listTabs.ts`
- Create: `src/tools/fetchGet.ts`
- Create: `tests/tools/fetchGet.test.ts`（其它工具与 readPage 同构，单测 fetchGet 即可）

- [ ] **Step 1: readSelection**

`src/tools/readSelection.ts`：
```ts
import { makeError } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

export const readSelectionTool: ToolDefinition<{}, { text: string }> = {
  name: 'readSelection',
  description: "Read the user's currently selected text on the active tab.",
  inputSchema: { type: 'object', properties: {} },
  exec: 'content',
  async execute(_input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', 'no active tab')
    return (await ctx.rpc.domOp({ kind: 'dom/readSelection', tabId: ctx.tabId })) as any
  },
}
```

- [ ] **Step 2: querySelector**

`src/tools/querySelector.ts`：
```ts
import { makeError } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

interface Input {
  selector: string
  all?: boolean
}
interface Output {
  matches: Array<{ text: string; outerHtml: string; rect: { x: number; y: number; width: number; height: number } }>
}

export const querySelectorTool: ToolDefinition<Input, Output> = {
  name: 'querySelector',
  description: 'Find DOM elements on the active tab matching a CSS selector.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector' },
      all: { type: 'boolean', description: 'Return all matches (default just first)', default: false },
    },
    required: ['selector'],
  },
  exec: 'content',
  async execute(input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', 'no active tab')
    return (await ctx.rpc.domOp({
      kind: 'dom/querySelector',
      tabId: ctx.tabId,
      selector: input.selector,
      all: input.all ?? false,
    })) as any
  },
}
```

- [ ] **Step 3: screenshot**

`src/tools/screenshot.ts`：
```ts
import { makeError } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

export const screenshotTool: ToolDefinition<{}, { dataUrl: string }> = {
  name: 'screenshot',
  description: 'Capture a screenshot of the visible area of the active tab.',
  inputSchema: { type: 'object', properties: {} },
  exec: 'sw',
  async execute(_input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', 'no active tab')
    return (await ctx.rpc.chromeApi('tabs.captureVisibleTab', [])) as any
  },
}
```

- [ ] **Step 4: listTabs**

`src/tools/listTabs.ts`：
```ts
import type { ToolDefinition } from '@shared/types'

interface TabSummary {
  id: number
  url: string
  title: string
  active: boolean
}

export const listTabsTool: ToolDefinition<{}, { tabs: TabSummary[] }> = {
  name: 'listTabs',
  description: 'List all open browser tabs (id, url, title, active).',
  inputSchema: { type: 'object', properties: {} },
  exec: 'sw',
  async execute(_input, ctx) {
    return (await ctx.rpc.chromeApi('tabs.query', [{}])) as any
  },
}
```

- [ ] **Step 5: fetchGet（带测试）**

`src/tools/fetchGet.ts`：
```ts
import { makeOk, makeError } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

interface Input {
  url: string
  headers?: Record<string, string>
}
interface Output {
  status: number
  contentType: string
  body: string
  truncated: boolean
}

const MAX_BODY_BYTES = 200 * 1024 // 200 KB cap

export const fetchGetTool: ToolDefinition<Input, Output> = {
  name: 'fetchGet',
  description:
    'Fetch a URL with HTTP GET and return the response body as text (truncated at 200KB). For non-GET, use a future fetchWrite tool that requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to fetch' },
      headers: { type: 'object', description: 'Optional request headers (no Authorization unless user opts in)' },
    },
    required: ['url'],
  },
  exec: 'offscreen',
  async execute(input) {
    try {
      const res = await fetch(input.url, {
        method: 'GET',
        headers: input.headers ?? {},
        // No credentials by default — extension fetch from offscreen has host_permissions, but
        // we don't want to leak the user's cookies to arbitrary URLs the agent decides to hit.
        credentials: 'omit',
      })
      const buf = new Uint8Array(await res.arrayBuffer())
      const truncated = buf.byteLength > MAX_BODY_BYTES
      const sliced = truncated ? buf.slice(0, MAX_BODY_BYTES) : buf
      const body = new TextDecoder('utf-8', { fatal: false }).decode(sliced)
      return makeOk({
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        truncated,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return makeError('fetch_failed', msg, true)
    }
  },
}
```

`tests/tools/fetchGet.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchGetTool } from '@/tools/fetchGet'

const ctx = {
  conversationId: 'c',
  tabId: 1,
  rpc: { domOp: vi.fn(), chromeApi: vi.fn() },
} as any

describe('fetchGet', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns ok with body and content-type', async () => {
    ;(fetch as any).mockResolvedValue(
      new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const r = await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.status).toBe(200)
      expect(r.data.contentType).toBe('application/json')
      expect(r.data.body).toBe('{"a":1}')
      expect(r.data.truncated).toBe(false)
    }
  })

  it('uses credentials: omit', async () => {
    ;(fetch as any).mockResolvedValue(new Response('', { status: 200 }))
    await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect((fetch as any).mock.calls[0][1].credentials).toBe('omit')
  })

  it('returns retryable error on network failure', async () => {
    ;(fetch as any).mockRejectedValue(new TypeError('network'))
    const r = await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.retryable).toBe(true)
  })

  it('truncates body over 200KB', async () => {
    const big = 'A'.repeat(300 * 1024)
    ;(fetch as any).mockResolvedValue(new Response(big, { status: 200 }))
    const r = await fetchGetTool.execute({ url: 'https://x.test' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.truncated).toBe(true)
      expect(r.data.body.length).toBe(200 * 1024)
    }
  })
})
```

跑 `bun run test -- tools/`，预期总 7 条全绿（registry 4 + readPage 3 + fetchGet 4 = 11，但其中 readPage 和 registry 已经在前面）。

修正：本任务结束后 tools/ 下应该是 4 + 3 + 4 = 11 条新测试。

---

## Section 5 — Agent QueryEngine

### Task 7: 简单 token 估算

**Files:**
- Create: `src/agent/query/tokenBudget.ts`
- Create: `tests/agent/tokenBudget.test.ts`

- [ ] **Step 1: 写测试 + 实现**

`src/agent/query/tokenBudget.ts`：
```ts
/**
 * Rough token count: ~4 chars per token for English text. Good enough for a budget
 * approximation. Plan D may swap in a real BPE tokenizer if compaction needs precision.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessageTokens(msg: { content: unknown }): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content)
  if (Array.isArray(msg.content)) {
    let n = 0
    for (const part of msg.content) {
      if (typeof part === 'string') n += estimateTokens(part)
      else if (part && typeof part === 'object' && 'text' in part && typeof (part as any).text === 'string') {
        n += estimateTokens((part as any).text)
      }
    }
    return n
  }
  return 0
}
```

`tests/agent/tokenBudget.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessageTokens } from '@/agent/query/tokenBudget'

describe('tokenBudget', () => {
  it('estimates 1 token per ~4 chars', () => {
    expect(estimateTokens('test')).toBe(1)
    expect(estimateTokens('test1234')).toBe(2)
  })
  it('handles empty and short', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
  })
  it('counts string content', () => {
    expect(estimateMessageTokens({ content: 'hello world!' })).toBe(3)
  })
  it('sums array content text parts', () => {
    expect(estimateMessageTokens({ content: [{ type: 'text', text: 'aaaa' }, { type: 'text', text: 'bbbb' }] })).toBe(2)
  })
  it('returns 0 for unknown shapes', () => {
    expect(estimateMessageTokens({ content: 12345 } as any)).toBe(0)
  })
})
```

跑预期 5 绿。

### Task 8: QueryEngine

**Files:**
- Create: `src/agent/query/QueryEngine.ts`
- Create: `tests/agent/QueryEngine.test.ts`

QueryEngine 接收：
- `messages`: 当前对话消息历史（OpenAI 格式）
- `tools`: 可用工具集（OpenAI tools[]）
- `client`: LLM 客户端
- `executeTool`: 执行工具的回调（offscreen 注入）
- `signal`: 取消信号

返回 async iterator，发出 `EngineEvent`：
- `assistant_delta` 文本流
- `assistant_tool_call_start` / `assistant_tool_call_end`
- `tool_executing` / `tool_result`
- `done`

- [ ] **Step 1: 写失败测试**

`tests/agent/QueryEngine.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { QueryEngine } from '@/agent/query/QueryEngine'
import type { OpenAICompatibleClient, StreamEvent } from '@/agent/api/openaiCompatibleClient'

function fakeClient(scripts: StreamEvent[][]): OpenAICompatibleClient {
  let turn = 0
  return {
    async *streamChat() {
      const chunks = scripts[turn++] ?? []
      for (const c of chunks) yield c
    },
  } as any
}

describe('QueryEngine', () => {
  it('streams assistant delta and finishes on stop', async () => {
    const client = fakeClient([
      [
        { kind: 'delta', text: 'Hello' },
        { kind: 'delta', text: ' world' },
        { kind: 'done', stopReason: 'stop' },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [],
      executeTool: async () => ({ ok: false, error: { code: 'no_tools', message: '', retryable: false } }),
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'hi' }])) events.push(ev)
    const text = events.filter((e) => e.kind === 'assistant_delta').map((e) => e.text).join('')
    expect(text).toBe('Hello world')
    const done = events.find((e) => e.kind === 'done')
    expect(done.stopReason).toBe('end_turn')
  })

  it('runs a tool call and continues with tool result', async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true, data: { text: 'page content' } })
    const client = fakeClient([
      [{ kind: 'done', stopReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'readPage', input: { mode: 'text' } }] }],
      [
        { kind: 'delta', text: 'The page says page content.' },
        { kind: 'done', stopReason: 'stop' },
      ],
    ])
    const engine = new QueryEngine({
      client,
      tools: [
        {
          type: 'function',
          function: { name: 'readPage', description: '', parameters: { type: 'object' } },
        },
      ],
      executeTool: exec,
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'what is on the page' }])) events.push(ev)
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0][0]).toEqual({ id: 'c1', name: 'readPage', input: { mode: 'text' } })
    const finalText = events
      .filter((e) => e.kind === 'assistant_delta')
      .map((e) => e.text)
      .join('')
    expect(finalText).toContain('page content')
  })

  it('halts at toolMaxIterations', async () => {
    let n = 0
    const client = fakeClient([
      [{ kind: 'done', stopReason: 'tool_calls', toolCalls: [{ id: `c${n}`, name: 'noop', input: {} }] }],
      [{ kind: 'done', stopReason: 'tool_calls', toolCalls: [{ id: `c${n}`, name: 'noop', input: {} }] }],
      [{ kind: 'done', stopReason: 'tool_calls', toolCalls: [{ id: `c${n}`, name: 'noop', input: {} }] }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [{ type: 'function', function: { name: 'noop', description: '', parameters: { type: 'object' } } }],
      executeTool: async () => ({ ok: true, data: 'done' }),
      toolMaxIterations: 2,
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'go' }])) events.push(ev)
    const done = events.find((e) => e.kind === 'done')
    expect(done.stopReason).toBe('max_iterations')
  })

  it('forwards tool errors as tool_result with is_error', async () => {
    const exec = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'no_active_tab', message: 'no tab', retryable: false },
    })
    const client = fakeClient([
      [{ kind: 'done', stopReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'readPage', input: {} }] }],
      [{ kind: 'delta', text: 'sorry' }, { kind: 'done', stopReason: 'stop' }],
    ])
    const engine = new QueryEngine({
      client,
      tools: [{ type: 'function', function: { name: 'readPage', description: '', parameters: { type: 'object' } } }],
      executeTool: exec,
    })
    const events: any[] = []
    for await (const ev of engine.run([{ role: 'user', content: 'try' }])) events.push(ev)
    const tr = events.find((e) => e.kind === 'tool_result')
    expect(tr.isError).toBe(true)
  })
})
```

- [ ] **Step 2: 实现 QueryEngine**

`src/agent/query/QueryEngine.ts`：
```ts
import type { OpenAICompatibleClient, ChatMessage, StreamEvent } from '@/agent/api/openaiCompatibleClient'
import type { ToolCall, ToolResult } from '@shared/types'

export type EngineEvent =
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'assistant_message_complete'; text: string; toolCalls: ToolCall[] }
  | { kind: 'tool_executing'; call: ToolCall }
  | { kind: 'tool_result'; callId: string; content: string; isError: boolean }
  | {
      kind: 'done'
      stopReason: 'end_turn' | 'tool_use' | 'max_iterations' | 'cancel' | 'error'
      error?: { code: string; message: string }
    }

export interface QueryEngineOptions {
  client: OpenAICompatibleClient
  tools: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  executeTool: (call: ToolCall) => Promise<ToolResult>
  toolMaxIterations?: number
  systemPrompt?: string
  signal?: AbortSignal
}

export class QueryEngine {
  constructor(private opts: QueryEngineOptions) {}

  async *run(initialMessages: ChatMessage[]): AsyncIterable<EngineEvent> {
    const max = this.opts.toolMaxIterations ?? 50
    const history: ChatMessage[] = []
    if (this.opts.systemPrompt) history.push({ role: 'system', content: this.opts.systemPrompt })
    history.push(...initialMessages)

    for (let iter = 0; iter < max; iter++) {
      let assistantText = ''
      const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>()
      let stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown' = 'stop'
      let toolCallsFinal: ToolCall[] = []

      try {
        for await (const ev of this.opts.client.streamChat({
          messages: history,
          tools: this.opts.tools.length ? this.opts.tools : undefined,
          signal: this.opts.signal,
        })) {
          if (ev.kind === 'delta') {
            assistantText += ev.text
            yield { kind: 'assistant_delta', text: ev.text }
          } else if (ev.kind === 'toolDelta') {
            const cur = toolCallAcc.get(ev.index) ?? { id: '', name: '', arguments: '' }
            if (ev.id) cur.id = ev.id
            if (ev.name) cur.name = ev.name
            if (ev.argumentsDelta) cur.arguments += ev.argumentsDelta
            toolCallAcc.set(ev.index, cur)
          } else if (ev.kind === 'done') {
            stopReason = ev.stopReason
            toolCallsFinal = (ev.toolCalls ?? []).map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.input,
            }))
          }
        }
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        yield { kind: 'done', stopReason: 'error', error: { code: 'llm_error', message: msg } }
        return
      }

      // Push assistant message into history regardless of stop reason
      const assistantHistoryMsg: ChatMessage = {
        role: 'assistant',
        content: assistantText,
      }
      if (toolCallsFinal.length) {
        assistantHistoryMsg.tool_calls = toolCallsFinal.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        }))
      }
      history.push(assistantHistoryMsg)

      yield {
        kind: 'assistant_message_complete',
        text: assistantText,
        toolCalls: toolCallsFinal,
      }

      if (stopReason !== 'tool_calls' || toolCallsFinal.length === 0) {
        yield { kind: 'done', stopReason: 'end_turn' }
        return
      }

      // Execute each tool call serially, push tool results back to history
      for (const call of toolCallsFinal) {
        yield { kind: 'tool_executing', call }
        const result = await this.opts.executeTool(call)
        const content = result.ok
          ? typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data)
          : JSON.stringify(result.error)
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content,
        })
        yield {
          kind: 'tool_result',
          callId: call.id,
          content,
          isError: !result.ok,
        }
      }
    }

    yield { kind: 'done', stopReason: 'max_iterations' }
  }
}
```

跑 `bun run test -- agent/QueryEngine`，预期 4 绿。

---

## Section 6 — Service Worker hub 转发模式

### Task 9: hub 改为 offscreen-forward + 写测试

**Files:**
- Modify: `src/extension/rpc/hub.ts`
- Create: `tests/rpc/hub-forward.test.ts`

forward 模式行为：
- 当 content script 连接时，SW 同时确保 offscreen 存在并连接一条 SW ↔ offscreen 的 internal port
- content → SW 收到的 ClientCmd 转发到 offscreen
- offscreen → SW 收到的 AgentEvent 转发到对应的 content port

简化设计：所有 content port 共享一条 SW ↔ offscreen 的 broadcast channel；offscreen 发出的事件按 sessionId 路由到匹配的 content port。

由于完整 forward 实现引入跨进程协调复杂度，**Plan B 采用一个稍简化的方案**：
- SW 维护 `clientPortsBySession: Map<sessionId, Port>`
- SW 在 content 连接时记录 sessionId（从第一条 ClientCmd 拿到）
- SW 通过 `chrome.runtime.connect({ name: 'sw-to-offscreen' })` 主动连 offscreen
- offscreen 端监听这条 port，收到 ClientCmd 就跑 agent；发出的 AgentEvent 带 sessionId，SW 路由

测试时，由于 mock 不能区分"offscreen vs content"，本测试只验证转发行为：模拟一个"假 offscreen 服务"通过 onConnect 接管 'sw-to-offscreen' port，确认 SW 正确把 client 的命令转过去。

- [ ] **Step 1: 修 hub.ts**

替换整个 `src/extension/rpc/hub.ts`：
```ts
import { ClientCmd, AgentEvent } from './protocol'

export interface HubOptions {
  mode: 'echo' | 'offscreen-forward'
  /** Used in tests to override the "find an offscreen port" behavior */
  offscreenPortName?: string
}

const DEFAULT_OFFSCREEN_PORT = 'sw-to-offscreen'
const UNKNOWN_SESSION_ID = '00000000-0000-4000-8000-000000000000'

interface Session {
  port: chrome.runtime.Port
  sessionId: string
}

export function installHub(options: HubOptions = { mode: 'echo' }) {
  const offscreenPortName = options.offscreenPortName ?? DEFAULT_OFFSCREEN_PORT
  const sessionsByPort = new Map<chrome.runtime.Port, Session>()
  const sessionsById = new Map<string, Session>()
  let offscreenPort: chrome.runtime.Port | null = null
  const offscreenPendingMessages: unknown[] = []

  function ensureOffscreenPort() {
    if (offscreenPort) return
    if (options.mode !== 'offscreen-forward') return
    try {
      offscreenPort = chrome.runtime.connect({ name: offscreenPortName })
      offscreenPort.onMessage.addListener((raw) => routeAgentEventToClient(raw))
      offscreenPort.onDisconnect.addListener(() => {
        offscreenPort = null
      })
      // Drain queue
      while (offscreenPendingMessages.length) {
        offscreenPort.postMessage(offscreenPendingMessages.shift())
      }
    } catch {
      // No offscreen runtime listening yet — keep null and retry on next message
    }
  }

  function routeAgentEventToClient(raw: unknown) {
    const parsed = AgentEvent.safeParse(raw)
    if (!parsed.success) return
    const ev = parsed.data
    const session = sessionsById.get(ev.sessionId)
    if (session) session.port.postMessage(ev)
  }

  function forwardClientCmdToOffscreen(cmd: unknown) {
    if (!offscreenPort) {
      offscreenPendingMessages.push(cmd)
      ensureOffscreenPort()
      return
    }
    offscreenPort.postMessage(cmd)
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'session') return
    const session: Session = { port, sessionId: '' }
    sessionsByPort.set(port, session)

    port.onMessage.addListener((raw) => {
      const parsed = ClientCmd.safeParse(raw)
      if (!parsed.success) {
        port.postMessage(ackError((raw as any)?.id, 'schema_invalid', parsed.error.message))
        return
      }
      const cmd = parsed.data
      if (!session.sessionId) {
        session.sessionId = cmd.sessionId
        sessionsById.set(cmd.sessionId, session)
      }
      port.postMessage(ack(cmd.id, cmd.sessionId))

      if (options.mode === 'echo' && cmd.kind === 'ping') {
        port.postMessage({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'pong',
        } as any)
      } else if (options.mode === 'offscreen-forward') {
        ensureOffscreenPort()
        forwardClientCmdToOffscreen(cmd)
      }
    })

    port.onDisconnect.addListener(() => {
      sessionsByPort.delete(port)
      if (session.sessionId) sessionsById.delete(session.sessionId)
    })
  })
}

function ack(correlationId: string, sessionId: string) {
  return {
    id: crypto.randomUUID(),
    sessionId,
    ts: Date.now(),
    kind: 'command/ack' as const,
    correlationId,
    ok: true,
  }
}

function ackError(correlationId: string | undefined, code: string, message: string) {
  return {
    id: crypto.randomUUID(),
    sessionId: UNKNOWN_SESSION_ID,
    ts: Date.now(),
    kind: 'command/ack' as const,
    correlationId: correlationId ?? UNKNOWN_SESSION_ID,
    ok: false,
    error: { code, message },
  }
}
```

- [ ] **Step 2: 写转发测试**

`tests/rpc/hub-forward.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { installHub } from '@ext/rpc/hub'
import { RpcClient } from '@ext/rpc/client'

describe('hub offscreen-forward mode', () => {
  it('forwards ClientCmd to offscreen and routes events back by sessionId', async () => {
    installHub({ mode: 'offscreen-forward' })

    // Simulate a fake offscreen process by listening on the SW-to-offscreen port name.
    let received: any = null
    const offscreenSidePromise = new Promise<chrome.runtime.Port>((resolve) => {
      chrome.runtime.onConnect.addListener((p) => {
        if (p.name === 'sw-to-offscreen') resolve(p)
      })
    })

    const client = new RpcClient({ portName: 'session', ackTimeoutMs: 1000, reconnect: false })
    await client.connect()
    const ack = await client.send({ kind: 'chat/send', text: 'hello' })
    expect(ack.ok).toBe(true)

    const offscreenPort = await offscreenSidePromise
    offscreenPort.onMessage.addListener((m) => {
      received = m
    })
    // Give the queue a microtask to flush
    await new Promise((r) => setTimeout(r, 5))
    expect(received?.kind).toBe('chat/send')
    expect(received?.text).toBe('hello')

    // Simulate offscreen → SW event for that session
    const evtPromise = new Promise<any>((resolve) => {
      client.on('message/streamChunk', resolve)
    })
    offscreenPort.postMessage({
      id: crypto.randomUUID(),
      sessionId: client.sessionId,
      ts: Date.now(),
      kind: 'message/streamChunk',
      messageId: crypto.randomUUID(),
      delta: 'hi',
    })
    const evt = await evtPromise
    expect(evt.delta).toBe('hi')

    client.disconnect()
  })
})
```

- [ ] **Step 3: 跑测试**

```bash
bun run test -- rpc
```
预期：原 `hub.test.ts` 3 条 + 新 `hub-forward.test.ts` 1 条 = 4 绿。

---

## Section 7 — Offscreen 作为 agent runtime

### Task 10: offscreen 实现 agent runtime

**Files:**
- Modify: `src/extension/offscreen.ts`

- [ ] **Step 1: 重写 offscreen.ts**

`src/extension/offscreen.ts`：
```ts
import { ClientCmd, AgentEvent } from './rpc/protocol'
import { OpenAICompatibleClient } from '@/agent/api/openaiCompatibleClient'
import { QueryEngine } from '@/agent/query/QueryEngine'
import { ToolRegistry } from '@/tools/registry'
import { readPageTool } from '@/tools/readPage'
import { readSelectionTool } from '@/tools/readSelection'
import { querySelectorTool } from '@/tools/querySelector'
import { screenshotTool } from '@/tools/screenshot'
import { listTabsTool } from '@/tools/listTabs'
import { fetchGetTool } from '@/tools/fetchGet'
import { loadSettings } from './storage/settings'
import {
  createConversation,
  getConversation,
  listConversations,
} from './storage/conversations'
import {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
} from './storage/messages'
import type { ToolCall, ToolExecContext } from '@shared/types'
import type { ChatMessage } from '@/agent/api/openaiCompatibleClient'

console.log('[mycli-web] offscreen agent runtime booted at', new Date().toISOString())

const registry = new ToolRegistry()
registry.register(readPageTool)
registry.register(readSelectionTool)
registry.register(querySelectorTool)
registry.register(screenshotTool)
registry.register(listTabsTool)
registry.register(fetchGetTool)

let swPort: chrome.runtime.Port | null = null
const activeAborts = new Map<string, AbortController>()

// SW will connect to us via chrome.runtime.connect({ name: 'sw-to-offscreen' }).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sw-to-offscreen') return
  swPort = port
  port.onMessage.addListener((raw) => handleClientCmd(raw))
  port.onDisconnect.addListener(() => {
    swPort = null
    for (const [, ac] of activeAborts) ac.abort()
    activeAborts.clear()
  })
})

function emit(ev: any) {
  swPort?.postMessage(ev)
}

async function handleClientCmd(raw: unknown) {
  const parsed = ClientCmd.safeParse(raw)
  if (!parsed.success) return
  const cmd = parsed.data
  switch (cmd.kind) {
    case 'chat/send':
      void runChat(cmd)
      return
    case 'chat/cancel':
      for (const [, ac] of activeAborts) ac.abort()
      activeAborts.clear()
      return
    case 'chat/newConversation':
      await createConversation({ title: cmd.title ?? 'New chat' })
      return
    case 'chat/resubscribe':
      await pushSnapshot(cmd.sessionId, cmd.conversationId)
      return
    default:
      return
  }
}

async function activeConversationId(): Promise<string> {
  const all = await listConversations()
  if (all.length > 0) return all[0].id
  const conv = await createConversation({ title: 'New chat' })
  return conv.id
}

async function pushSnapshot(sessionId: string, conversationId?: string) {
  const cid = conversationId ?? (await activeConversationId())
  const conv = await getConversation(cid)
  if (!conv) return
  const messages = await listMessagesByConversation(cid)
  emit({
    id: crypto.randomUUID(),
    sessionId,
    ts: Date.now(),
    kind: 'state/snapshot',
    conversation: {
      id: conv.id,
      title: conv.title,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    },
  })
}

async function runChat(cmd: { sessionId: string; text: string }) {
  const settings = await loadSettings()
  if (!settings.apiKey) {
    emit({
      id: crypto.randomUUID(),
      sessionId: cmd.sessionId,
      ts: Date.now(),
      kind: 'fatalError',
      code: 'no_api_key',
      message: 'Configure API key in extension options first.',
    })
    return
  }

  const cid = await activeConversationId()
  const userMsg = await appendMessage({
    conversationId: cid,
    role: 'user',
    content: cmd.text,
  })
  emit({
    id: crypto.randomUUID(),
    sessionId: cmd.sessionId,
    ts: Date.now(),
    kind: 'message/appended',
    message: {
      id: userMsg.id,
      role: 'user',
      content: cmd.text,
      createdAt: userMsg.createdAt,
    },
  })

  const history = await listMessagesByConversation(cid)
  const llmHistory: ChatMessage[] = history.map((m) => ({
    role: m.role === 'system-synth' ? 'system' : (m.role as ChatMessage['role']),
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }))

  const client = new OpenAICompatibleClient({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
  })

  const abort = new AbortController()
  activeAborts.set(cmd.sessionId, abort)

  const tabId = (await guessActiveTab())?.id
  const ctx: ToolExecContext = {
    conversationId: cid,
    tabId,
    rpc: {
      domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
      chromeApi: (method, args) => callChromeApi(method, args),
    },
  }

  const engine = new QueryEngine({
    client,
    tools: registry.toOpenAi(),
    executeTool: async (call: ToolCall) => {
      const def = registry.get(call.name)
      if (!def) {
        return { ok: false, error: { code: 'unknown_tool', message: call.name, retryable: false } }
      }
      return def.execute(call.input as any, ctx)
    },
    toolMaxIterations: settings.toolMaxIterations,
    systemPrompt: settings.systemPromptAddendum || undefined,
    signal: abort.signal,
  })

  // Start a streaming assistant message row
  const assistantMsg = await appendMessage({
    conversationId: cid,
    role: 'assistant',
    content: '',
    pending: true,
  })

  let assistantBuf = ''
  try {
    for await (const ev of engine.run(llmHistory)) {
      if (ev.kind === 'assistant_delta') {
        assistantBuf += ev.text
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/streamChunk',
          messageId: assistantMsg.id,
          delta: ev.text,
        })
      } else if (ev.kind === 'tool_executing') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/start',
          toolCall: { id: ev.call.id, tool: ev.call.name, args: ev.call.input },
        })
      } else if (ev.kind === 'tool_result') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/end',
          toolCallId: ev.callId,
          result: { ok: !ev.isError, content: ev.content },
        })
      } else if (ev.kind === 'done') {
        await updateMessage(assistantMsg.id, { content: assistantBuf, pending: false })
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/appended',
          message: {
            id: assistantMsg.id,
            role: 'assistant',
            content: assistantBuf,
            createdAt: assistantMsg.createdAt,
          },
        })
      }
    }
  } catch (e: any) {
    emit({
      id: crypto.randomUUID(),
      sessionId: cmd.sessionId,
      ts: Date.now(),
      kind: 'fatalError',
      code: 'engine_error',
      message: e?.message ?? String(e),
    })
  } finally {
    activeAborts.delete(cmd.sessionId)
  }
}

async function guessActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return tabs[0]
  } catch {
    return undefined
  }
}

async function sendDomOp(op: any, timeoutMs: number) {
  // Forward through SW to the target tab's content script
  return new Promise<any>((resolve) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(
      () => resolve({ ok: false, error: { code: 'dom_op_timeout', message: 'no response', retryable: false } }),
      timeoutMs,
    )
    const listener = (msg: any) => {
      if (msg?.kind === 'dom_op_result' && msg.id === id) {
        chrome.runtime.onMessage.removeListener(listener)
        clearTimeout(timer)
        resolve(msg.result)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    chrome.runtime.sendMessage({ kind: 'dom_op_request', id, op })
  })
}

async function callChromeApi(method: string, args: unknown[]): Promise<any> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const listener = (msg: any) => {
      if (msg?.kind === 'chrome_api_result' && msg.id === id) {
        chrome.runtime.onMessage.removeListener(listener)
        resolve(msg.result)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    chrome.runtime.sendMessage({ kind: 'chrome_api_request', id, method, args })
  })
}
```

- [ ] **Step 2: SW 端补 dom_op / chrome_api 转发**

修改 `src/extension/background.ts`，在文件末尾追加：
```ts
// DOM op routing: offscreen → SW → target tab → result back to offscreen
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === 'dom_op_request') {
    const { id, op } = msg
    const tabId = op?.tabId
    if (typeof tabId !== 'number') {
      chrome.runtime.sendMessage({ kind: 'dom_op_result', id, result: { ok: false, error: { code: 'no_tab', message: 'op missing tabId', retryable: false } } })
      return false
    }
    chrome.tabs.sendMessage(tabId, { kind: 'dom_op', id, op }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({
          kind: 'dom_op_result',
          id,
          result: { ok: false, error: { code: 'tab_unreachable', message: chrome.runtime.lastError.message ?? '', retryable: true } },
        })
        return
      }
      chrome.runtime.sendMessage({ kind: 'dom_op_result', id, result: response })
    })
    return true
  }
  if (msg?.kind === 'chrome_api_request') {
    const { id, method, args } = msg
    handleChromeApi(method, args).then((result) =>
      chrome.runtime.sendMessage({ kind: 'chrome_api_result', id, result }),
    )
    return true
  }
  return false
})

async function handleChromeApi(method: string, args: any[]) {
  try {
    if (method === 'tabs.query') {
      const tabs = await chrome.tabs.query(args[0] ?? {})
      return {
        ok: true,
        data: {
          tabs: tabs.map((t) => ({
            id: t.id ?? -1,
            url: t.url ?? '',
            title: t.title ?? '',
            active: t.active,
          })),
        },
      }
    }
    if (method === 'tabs.captureVisibleTab') {
      const dataUrl = await chrome.tabs.captureVisibleTab()
      return { ok: true, data: { dataUrl } }
    }
    return { ok: false, error: { code: 'unknown_method', message: method, retryable: false } }
  } catch (e: any) {
    return { ok: false, error: { code: 'chrome_api_error', message: e?.message ?? String(e), retryable: true } }
  }
}
```

- [ ] **Step 3: 切 hub 模式**

修改 `background.ts` 文件中：
```ts
installHub({ mode: 'echo' })
```
改为：
```ts
installHub({ mode: 'offscreen-forward' })
```

---

## Section 8 — Content Script DOM handlers + Chat UI

### Task 11: content script DOM op handlers

**Files:**
- Create: `src/extension/content/domHandlers.ts`

DOM op handler 接收来自 SW 的 `{ kind: 'dom_op', id, op }`，按 op.kind 分派，结果通过 `sendResponse` 返回。

- [ ] **Step 1: 写 handler**

`src/extension/content/domHandlers.ts`：
```ts
function readPage(mode: 'text' | 'markdown' | 'html-simplified') {
  if (mode === 'text') {
    return { ok: true as const, data: { text: document.body?.innerText ?? '', url: location.href, title: document.title } }
  }
  if (mode === 'html-simplified') {
    return {
      ok: true as const,
      data: { text: document.body?.outerHTML?.slice(0, 100_000) ?? '', url: location.href, title: document.title },
    }
  }
  // markdown: very rough — convert headings + paragraphs only
  const lines: string[] = []
  document.querySelectorAll('h1, h2, h3, p, li').forEach((el) => {
    const tag = el.tagName.toLowerCase()
    const text = (el.textContent ?? '').trim()
    if (!text) return
    if (tag === 'h1') lines.push(`# ${text}`)
    else if (tag === 'h2') lines.push(`## ${text}`)
    else if (tag === 'h3') lines.push(`### ${text}`)
    else if (tag === 'li') lines.push(`- ${text}`)
    else lines.push(text)
  })
  return { ok: true as const, data: { text: lines.join('\n\n'), url: location.href, title: document.title } }
}

function readSelection() {
  const sel = window.getSelection()?.toString() ?? ''
  return { ok: true as const, data: { text: sel } }
}

function querySelectorOp(selector: string, all: boolean) {
  let nodes: Element[] = []
  try {
    nodes = all ? Array.from(document.querySelectorAll(selector)) : (document.querySelector(selector) ? [document.querySelector(selector) as Element] : [])
  } catch (e: any) {
    return { ok: false as const, error: { code: 'invalid_selector', message: e?.message ?? '', retryable: false } }
  }
  return {
    ok: true as const,
    data: {
      matches: nodes.slice(0, 20).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          text: (el.textContent ?? '').trim().slice(0, 500),
          outerHtml: el.outerHTML.slice(0, 2000),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        }
      }),
    },
  }
}

export function installDomHandlers() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.kind !== 'dom_op') return false
    const { op } = msg
    try {
      if (op.kind === 'dom/readPage') {
        sendResponse(readPage(op.mode))
      } else if (op.kind === 'dom/readSelection') {
        sendResponse(readSelection())
      } else if (op.kind === 'dom/querySelector') {
        sendResponse(querySelectorOp(op.selector, op.all ?? false))
      } else {
        sendResponse({ ok: false, error: { code: 'unknown_op', message: op.kind, retryable: false } })
      }
    } catch (e: any) {
      sendResponse({ ok: false, error: { code: 'handler_error', message: e?.message ?? String(e), retryable: false } })
    }
    return true
  })
}
```

### Task 12: 真实聊天 UI

**Files:**
- Create: `src/extension/ui/MessageBubble.tsx`
- Create: `src/extension/ui/MessageList.tsx`
- Create: `src/extension/ui/Composer.tsx`
- Create: `src/extension/ui/ToolCallCard.tsx`
- Create: `src/extension/ui/ChatWindow.tsx`
- Create: `src/extension/content/ChatApp.tsx`
- Modify: `src/extension/content/index.tsx`

由于 UI 是大量 React 组件，下面给出必要文件的完整内容：

`src/extension/ui/MessageBubble.tsx`：
```tsx
interface Props {
  role: 'user' | 'assistant' | 'tool'
  content: string
  pending?: boolean
}

export function MessageBubble({ role, content, pending }: Props) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900'
        }`}
      >
        {content || (pending ? <span className="opacity-50">…</span> : null)}
        {pending && content && <span className="ml-1 animate-pulse">▍</span>}
      </div>
    </div>
  )
}
```

`src/extension/ui/ToolCallCard.tsx`：
```tsx
interface Props {
  tool: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  result?: string
}

export function ToolCallCard({ tool, args, status, result }: Props) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold">{tool}</span>
        <span className={
          status === 'running'
            ? 'text-blue-600'
            : status === 'ok'
              ? 'text-green-600'
              : 'text-red-600'
        }>
          {status}
        </span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-slate-500">args</summary>
        <pre className="mt-1 overflow-x-auto text-[11px]">{JSON.stringify(args, null, 2)}</pre>
      </details>
      {result && (
        <details className="mt-1">
          <summary className="cursor-pointer text-slate-500">result</summary>
          <pre className="mt-1 overflow-x-auto text-[11px]">{result.slice(0, 2000)}</pre>
        </details>
      )}
    </div>
  )
}
```

`src/extension/ui/MessageList.tsx`：
```tsx
import { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import { ToolCallCard } from './ToolCallCard'

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  pending?: boolean
}

export interface DisplayToolCall {
  id: string
  tool: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  result?: string
  /** Anchor: insert after this assistant message id */
  afterMessageId: string
}

interface Props {
  messages: DisplayMessage[]
  toolCalls: DisplayToolCall[]
}

export function MessageList({ messages, toolCalls }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, toolCalls.length])

  return (
    <div ref={ref} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((m) => (
        <div key={m.id} className="space-y-2">
          {m.role !== 'tool' && (
            <MessageBubble role={m.role} content={m.content} pending={m.pending} />
          )}
          {toolCalls
            .filter((t) => t.afterMessageId === m.id)
            .map((t) => (
              <ToolCallCard key={t.id} tool={t.tool} args={t.args} status={t.status} result={t.result} />
            ))}
        </div>
      ))}
    </div>
  )
}
```

`src/extension/ui/Composer.tsx`：
```tsx
import { useState } from 'react'

interface Props {
  onSend: (text: string) => void
  disabled?: boolean
}

export function Composer({ onSend, disabled }: Props) {
  const [text, setText] = useState('')
  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() || disabled) return
    onSend(text.trim())
    setText('')
  }
  return (
    <form onSubmit={submit} className="border-t border-slate-200 p-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e as any)
        }}
        placeholder="Ask anything (Cmd/Ctrl+Enter to send)…"
        disabled={disabled}
        className="block h-16 w-full resize-none rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
      />
      <div className="mt-1 flex justify-end">
        <button
          type="submit"
          disabled={!text.trim() || disabled}
          className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </form>
  )
}
```

`src/extension/ui/ChatWindow.tsx`：
```tsx
import { MessageList, type DisplayMessage, type DisplayToolCall } from './MessageList'
import { Composer } from './Composer'

interface Props {
  messages: DisplayMessage[]
  toolCalls: DisplayToolCall[]
  onSend: (text: string) => void
  onNewConversation: () => void
  busy: boolean
  errorBanner?: string
}

export function ChatWindow({ messages, toolCalls, onSend, onNewConversation, busy, errorBanner }: Props) {
  return (
    <div
      className="fixed right-4 bottom-20 flex h-[32rem] w-96 flex-col rounded-lg border border-slate-200 bg-white shadow-xl"
      style={{ zIndex: 2147483647 }}
    >
      <div className="flex h-10 items-center justify-between border-b border-slate-200 px-3 text-sm font-semibold text-slate-700">
        <span>mycli-web</span>
        <button
          onClick={onNewConversation}
          className="rounded px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          type="button"
        >
          New chat
        </button>
      </div>
      {errorBanner && (
        <div className="bg-red-50 px-3 py-1 text-xs text-red-700 border-b border-red-200">{errorBanner}</div>
      )}
      <MessageList messages={messages} toolCalls={toolCalls} />
      <Composer onSend={onSend} disabled={busy} />
    </div>
  )
}
```

`src/extension/content/ChatApp.tsx`：
```tsx
import { useEffect, useRef, useState } from 'react'
import { Fab } from './fab'
import { ChatWindow } from '../ui/ChatWindow'
import type { DisplayMessage, DisplayToolCall } from '../ui/MessageList'
import { RpcClient } from '../rpc/client'
import { getTransientUi, setTransientUi } from '../storage/transient'
import { loadSettings } from '../storage/settings'

export function ChatApp() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [toolCalls, setToolCalls] = useState<DisplayToolCall[]>([])
  const [busy, setBusy] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | undefined>(undefined)
  const [position, setPosition] = useState<'bottom-right' | 'bottom-left'>('bottom-right')
  const clientRef = useRef<RpcClient | null>(null)
  const lastAssistantIdRef = useRef<string | null>(null)

  useEffect(() => {
    void (async () => {
      const settings = await loadSettings()
      setPosition(settings.fab.position)
      const ui = await getTransientUi()
      setOpen(ui.panelOpen)
      const client = new RpcClient({ portName: 'session' })
      clientRef.current = client
      await client.connect()
      // Subscribe before sending anything
      client.on('message/appended', (ev: any) => {
        setMessages((prev) => {
          if (prev.find((p) => p.id === ev.message.id)) {
            return prev.map((p) =>
              p.id === ev.message.id ? { ...p, content: ev.message.content, pending: false } : p,
            )
          }
          return [...prev, { id: ev.message.id, role: ev.message.role, content: ev.message.content, pending: false }]
        })
        if (ev.message.role === 'assistant') {
          lastAssistantIdRef.current = ev.message.id
          setBusy(false)
        }
      })
      client.on('message/streamChunk', (ev: any) => {
        lastAssistantIdRef.current = ev.messageId
        setMessages((prev) => {
          const idx = prev.findIndex((p) => p.id === ev.messageId)
          if (idx === -1) {
            return [...prev, { id: ev.messageId, role: 'assistant', content: ev.delta, pending: true }]
          }
          const copy = [...prev]
          copy[idx] = { ...copy[idx], content: copy[idx].content + ev.delta, pending: true }
          return copy
        })
      })
      client.on('tool/start', (ev: any) => {
        const anchor = lastAssistantIdRef.current ?? ''
        setToolCalls((prev) => [
          ...prev,
          { id: ev.toolCall.id, tool: ev.toolCall.tool, args: ev.toolCall.args, status: 'running', afterMessageId: anchor },
        ])
      })
      client.on('tool/end', (ev: any) => {
        setToolCalls((prev) =>
          prev.map((t) =>
            t.id === ev.toolCallId
              ? { ...t, status: ev.result.ok ? 'ok' : 'error', result: ev.result.content }
              : t,
          ),
        )
      })
      client.on('fatalError', (ev: any) => {
        setBusy(false)
        setErrorBanner(`${ev.code}: ${ev.message}`)
      })

      const tabListener = (msg: any) => {
        if (msg?.kind === 'content/activate') setOpen(true)
      }
      chrome.runtime.onMessage.addListener(tabListener)
      return () => chrome.runtime.onMessage.removeListener(tabListener)
    })()
  }, [])

  async function toggle() {
    const next = !open
    setOpen(next)
    await setTransientUi({ panelOpen: next })
  }

  function send(text: string) {
    if (!clientRef.current) return
    setBusy(true)
    setErrorBanner(undefined)
    clientRef.current.send({ kind: 'chat/send', text })
  }

  function newConversation() {
    if (!clientRef.current) return
    setMessages([])
    setToolCalls([])
    clientRef.current.send({ kind: 'chat/newConversation' })
  }

  return (
    <>
      <Fab onClick={toggle} position={position} />
      {open && (
        <ChatWindow
          messages={messages}
          toolCalls={toolCalls}
          onSend={send}
          onNewConversation={newConversation}
          busy={busy}
          errorBanner={errorBanner}
        />
      )}
    </>
  )
}
```

`src/extension/content/index.tsx`（替换原内容）：
```tsx
import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { ChatApp } from './ChatApp'
import { installDomHandlers } from './domHandlers'
import { loadSettings } from '../storage/settings'
import contentCss from '../../styles/content.css?inline'

async function mount() {
  const settings = await loadSettings()
  if (!settings.fab.enabled) return

  // Install DOM op handlers (these run regardless of FAB visibility, so the
  // agent can call into this tab even if user has FAB hidden via settings).
  installDomHandlers()

  const host = document.createElement('div')
  host.id = 'mycli-web-root'
  host.style.all = 'initial'
  document.documentElement.appendChild(host)
  const shadow = host.attachShadow({ mode: 'closed' })

  const styleEl = document.createElement('style')
  styleEl.textContent = contentCss
  shadow.appendChild(styleEl)

  const mountNode = document.createElement('div')
  mountNode.id = 'mycli-web-mount'
  shadow.appendChild(mountNode)

  createRoot(mountNode).render(
    <StrictMode>
      <ChatApp />
    </StrictMode>,
  )
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount())
} else {
  mount()
}
```

注意：`installDomHandlers()` 也要在 FAB 被禁用时仍然安装（这样 agent 仍能从其他 tab 触发），所以放在 settings 检查之外。等等——重读 spec 后，把 `installDomHandlers()` 放到 settings.fab.enabled 早期返回**之前**（这样即使浮窗禁用也能响应 dom op）。修订后：

```tsx
async function mount() {
  installDomHandlers()  // always install, independent of FAB
  const settings = await loadSettings()
  if (!settings.fab.enabled) return
  // ... rest of UI mount
}
```

---

## Section 9 — 构建 / typecheck / 烟测

### Task 13: typecheck + build + 全量测试

- [ ] **Step 1: typecheck**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck
```
预期：无错误。如有 type error，逐一修。

- [ ] **Step 2: build**

```bash
bun run build
```
预期：dist/ 包含所有 entry，无错误。注意 vite 可能对动态 chrome.* import 警告，但不影响功能。

- [ ] **Step 3: 全量测试**

```bash
bun run test
```
预期：~68 条全绿（43 Plan A + ~25 Plan B 新增）。

### Task 14: 用户手工烟测（Chrome）

- [ ] **Step 1: 重新加载扩展**

`chrome://extensions` → mycli-web 卡片 → reload。

- [ ] **Step 2: 配置 API key**

打开 options 页，填入：
- `apiKey`：你的 OpenAI/Anthropic-compatible/任何兼容服务的 key
- `baseUrl`：（默认 `https://api.openai.com/v1` 即可，或你的自建网关）
- `model`：`gpt-4o-mini` 或你想用的模型
- 保存。

- [ ] **Step 3: 测试基础对话**

打开 `https://example.com`，按 `Cmd+Shift+K` 打开浮窗。输入 "hello"。
预期：流式 assistant 回复出现。

- [ ] **Step 4: 测试 readPage 工具**

输入 "What is on this page? Use readPage if needed."
预期：浮窗里显示 ToolCallCard `readPage running → ok`，然后 assistant 用页面内容回答。

- [ ] **Step 5: 测试 fetchGet**

输入 "Fetch https://api.github.com/repos/nodejs/node/releases/latest and tell me the version."
预期：fetchGet 调用成功，返回最新版本号。

- [ ] **Step 6: 测试 New chat**

点击浮窗右上角 "New chat"。
预期：消息清空。

---

## Section 10 — 提交

### Task 15: git commit Plan B

- [ ] **Step 1: status + diff 检查**

```bash
git status
git diff --stat
```

- [ ] **Step 2: commit**

```bash
git -c user.name="mycli-web" -c user.email="noreply@local" commit -am "$(cat <<'EOF'
Plan B: agent core + read tools + minimal chat UI

- New minimal agent core (~600 lines instead of porting mycli's 5000):
  - openaiCompatibleClient: native fetch + SSE streaming, tool_calls support
  - QueryEngine: user → LLM → tools → LLM loop with toolMaxIterations cap
  - Tool protocol + ToolRegistry
  - tokenBudget rough estimator
- Six read tools: readPage / readSelection / querySelector / screenshot /
  listTabs / fetchGet (GET only, credentials: omit)
- SW hub upgraded from echo to offscreen-forward routing
- Offscreen document hosts the QueryEngine, drives chat sessions, persists
  messages to IndexedDB, emits AgentEvent stream
- Content script: real ChatApp with MessageList / ToolCallCard / Composer,
  replaces Plan A placeholder ChatShell
- Settings + API key flow end-to-end via chrome.storage.local
- ~25 new tests (LLM client SSE parsing, QueryEngine loop & errors, tools,
  tool registry, hub forward routing); total ~68 green

Plan C will add the approval engine + write-side tools (click/type/
fillForm/navigate/openTab/etc).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Plan B 完成标准

- [ ] `bun run typecheck` 干净
- [ ] `bun run build` 产出可加载 dist/
- [ ] `bun run test` ~68 条全绿
- [ ] Chrome 加载扩展后用户能进行真实 LLM 对话
- [ ] readPage 工具可被 LLM 调用并返回页面内容
- [ ] fetchGet 工具可调用并返回外网内容
- [ ] ToolCallCard 在浮窗里正常渲染
- [ ] git 多 1 个 Plan B commit

完成后 → **Plan C：审批引擎 + 写工具**。
