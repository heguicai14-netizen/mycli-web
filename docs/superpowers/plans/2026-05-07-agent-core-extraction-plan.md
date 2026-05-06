# agent-core 抽取实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前散落在 `src/agent/`、`src/tools/`、`src/shared/types.ts`、`src/extension/rpc/protocol.ts` 的"agent 引擎 + 协议"代码收敛到内部模块 `src/agent-core/`，把 chrome 特化工具抽到 `src/extension-tools/`，对外（对扩展入口代码）暴露稳定的 `createAgent({ llm, tools, toolContext })` 工厂。仍然单 npm package、不发布、不开 workspace。

**Architecture:** 单仓内三层目录拆分（`src/agent-core/` + `src/extension-tools/` + `src/extension/`），用 TypeScript project references 强制边界——`agent-core/tsconfig.json` 不加载 `@types/chrome`，任何 `chrome.xxx` 引用 typecheck 直接红。两阶段迁移：阶段 1（PR 1）抽 agent-core + 工厂；阶段 2（PR 2）抽 extension-tools + 清理旧 ctx 字段。

**Tech Stack:** TypeScript 5.5 + Vite 5 + @crxjs/vite-plugin + Zod + Vitest（jsdom + fake-indexeddb）；package manager bun ≥ 1.3.5；Node ≥ 24。

**Spec:** `docs/superpowers/specs/2026-05-07-agent-core-extraction-design.md`

---

## 全局约定

- 每完成一个 Task 跑一次 `bun run typecheck && bun run test` 验证。
- **commit 在每个阶段结束时一次性做**（PR 1 一个 commit，PR 2 一个 commit），不在 task 之间提交。
  这与本仓既有的 Plan A / Plan B commit 风格一致。
- 路径中的 `@core` 在 Task 1.1 创建别名后就立即可用；`@ext-tools` 在 Task 2.1 创建。
- 移动文件用 `git mv`，保留 history。
- 类型迁移期间 `ToolExecContext` 的旧字段（`tabId`、`rpc`、`exec`）保留并标 `@deprecated`，
  PR 2 才删除。
- 修改 `tsconfig.json` 后，typecheck 命令是 `bun run typecheck`（脚本会切到 `tsc -b`）。

---

## 阶段 1（PR 1）：agent-core 抽取 + createAgent 工厂

进入条件：当前 `main` 分支干净。
退出条件：扩展 build 成功、所有现有 tests 通过、`src/agent-core/**` 不引 chrome、`offscreen.ts` 改成
通过 `createAgent` 装配 agent；旧目录 `src/agent/` 与 `src/tools/fetchGet.ts` 删除；其它 chrome
工具仍留在 `src/tools/`（PR 2 才搬）。

### Task 1.1: 加 `@core` 路径别名 + 创建 agent-core 空壳

**Files:**
- Modify: `tsconfig.json` (顶层 `paths`)
- Modify: `vite.config.ts` (resolve.alias)
- Modify: `vitest.config.ts` (resolve.alias)
- Create: `src/agent-core/.gitkeep`

- [ ] **Step 1: 加 `@core` alias 到 `tsconfig.json`**

```json
"paths": {
  "@/*": ["./src/*"],
  "@shared/*": ["./src/shared/*"],
  "@ext/*": ["./src/extension/*"],
  "@core": ["./src/agent-core/index.ts"],
  "@core/*": ["./src/agent-core/*"]
}
```

- [ ] **Step 2: 加 `@core` alias 到 `vite.config.ts`**

把 `resolve.alias` 段改成：

```ts
resolve: {
  alias: {
    '@': path.resolve(__dirname, 'src'),
    '@shared': path.resolve(__dirname, 'src/shared'),
    '@ext': path.resolve(__dirname, 'src/extension'),
    '@core': path.resolve(__dirname, 'src/agent-core/index.ts'),
    '@core/': path.resolve(__dirname, 'src/agent-core/') + '/',
  },
},
```

注意：Vite 的 alias 用前缀匹配，加尾 `/` 区分 barrel 入口与子路径。

- [ ] **Step 3: 加 `@core` alias 到 `vitest.config.ts`**

同 Step 2，复制 `resolve.alias` 段。

- [ ] **Step 4: 创建 `src/agent-core/` 目录**

```bash
mkdir -p src/agent-core/tools
touch src/agent-core/.gitkeep
```

- [ ] **Step 5: 验证 typecheck**

Run: `bun run typecheck`
Expected: PASS（没动任何 .ts，只加了 alias 和空目录）

---

### Task 1.2: 抽出统一类型到 `src/agent-core/types.ts`

把 `src/shared/types.ts` 的内容整体搬到 `src/agent-core/types.ts`，并把 `src/shared/types.ts` 改
成"再导出 shim"——这样既有的 `import ... from '@shared/types'` 不必一次性改完。

**Files:**
- Create: `src/agent-core/types.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 写 `src/agent-core/types.ts`（与原内容一致 + 标 deprecated）**

```ts
// 中央类型定义。Plan B 抽核之后唯一的 agent 类型来源。
// 注意：ToolExecContext 的 tabId / rpc 字段在 PR 2 后会删除——它们属于 ExtensionToolCtx，
// 不属于 agent-core。当前为兼容旧扩展工具暂留。

export type Uuid = string

export type ConversationId = Uuid
export type MessageId = Uuid
export type ToolCallId = Uuid
export type ApprovalId = Uuid
export type SkillId = string

export type Role = 'user' | 'assistant' | 'tool' | 'system-synth'

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean; details?: unknown } }

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
  pending?: boolean
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
  inputSchema: Record<string, unknown>
  /** @deprecated PR 2 起执行位置由"工具来自哪个包"决定，此字段会删除 */
  exec?: 'content' | 'sw' | 'offscreen'
  execute(input: I, ctx: ToolExecContext): Promise<ToolResult<O>>
}

export interface ToolExecContext {
  conversationId: ConversationId
  /** @deprecated PR 2 起搬到 ExtensionToolCtx */
  tabId?: number
  /** @deprecated PR 2 起搬到 ExtensionToolCtx */
  rpc?: ToolExecRpc
}

export interface ToolExecRpc {
  domOp(op: unknown, timeoutMs?: number): Promise<ToolResult>
  chromeApi(method: string, args: unknown[]): Promise<ToolResult>
}
```

- [ ] **Step 2: 把 `src/shared/types.ts` 改成 re-export shim**

```ts
// 兼容 shim：所有类型已迁至 src/agent-core/types.ts。
// PR 1 期间保留此文件以避免一次性改所有 import 路径；PR 1 收尾时删除并改剩余 import。
export * from '@core/types'
```

- [ ] **Step 3: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS（类型定义同形，re-export 透传）

---

### Task 1.3: 搬 `Tool.ts` 到 agent-core

**Files:**
- Move: `src/agent/Tool.ts` → `src/agent-core/Tool.ts`
- Modify: `src/agent-core/Tool.ts` 内部 import 改用 `./types`
- Modify: `src/tools/{readPage,readSelection,querySelector,screenshot,listTabs,fetchGet}.ts` 与
  `src/tools/registry.ts` 的 `from '@/agent/Tool'` → `from '@core/Tool'`

- [ ] **Step 1: 用 `git mv` 搬文件**

```bash
git mv src/agent/Tool.ts src/agent-core/Tool.ts
```

- [ ] **Step 2: 改 `src/agent-core/Tool.ts` 顶部 import**

```ts
import type { ToolDefinition, ToolResult } from './types'

export type { ToolDefinition, ToolResult } from './types'
```

（保留 `toOpenAiTool` / `makeError` / `makeOk` 函数体不动。）

- [ ] **Step 3: 批量改 6 个 tool 文件 + registry 的 import**

对以下文件：
- `src/tools/readPage.ts`
- `src/tools/readSelection.ts`
- `src/tools/querySelector.ts`
- `src/tools/screenshot.ts`
- `src/tools/listTabs.ts`
- `src/tools/fetchGet.ts`
- `src/tools/registry.ts`

把 `from '@/agent/Tool'` 改为 `from '@core/Tool'`。比如 `src/tools/readPage.ts` 顶部：

```ts
import { makeError } from '@core/Tool'
import type { ToolDefinition } from '@shared/types'
```

- [ ] **Step 4: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

---

### Task 1.4: 搬 `OpenAICompatibleClient.ts` + `tokenBudget.ts` + `QueryEngine.ts`

**Files:**
- Move: `src/agent/api/openaiCompatibleClient.ts` → `src/agent-core/OpenAICompatibleClient.ts`
- Move: `src/agent/query/tokenBudget.ts` → `src/agent-core/tokenBudget.ts`
- Move: `src/agent/query/QueryEngine.ts` → `src/agent-core/QueryEngine.ts`
- Modify: 内部 import 路径
- Modify: 各 import 站点（offscreen.ts、tests/agent/*.test.ts）

- [ ] **Step 1: git mv 三个文件**

```bash
git mv src/agent/api/openaiCompatibleClient.ts src/agent-core/OpenAICompatibleClient.ts
git mv src/agent/query/tokenBudget.ts src/agent-core/tokenBudget.ts
git mv src/agent/query/QueryEngine.ts src/agent-core/QueryEngine.ts
```

- [ ] **Step 2: 改 `src/agent-core/QueryEngine.ts` 顶部 import**

```ts
import type {
  OpenAICompatibleClient,
  ChatMessage,
} from './OpenAICompatibleClient'
import type { ToolCall, ToolResult } from './types'
```

`OpenAICompatibleClient.ts` 与 `tokenBudget.ts` 当前没有内部 import，无须改。

- [ ] **Step 3: 改 `src/extension/offscreen.ts` 的 agent import**

```ts
import { OpenAICompatibleClient, type ChatMessage } from '@core/OpenAICompatibleClient'
import { QueryEngine } from '@core/QueryEngine'
```

（`@/agent/...` 路径全部退役。）

- [ ] **Step 4: 改测试文件 import**

`tests/agent/QueryEngine.test.ts`、`tests/agent/openaiCompatibleClient.test.ts`、
`tests/agent/tokenBudget.test.ts`：

```ts
// before
import { QueryEngine } from '@/agent/query/QueryEngine'
import type { OpenAICompatibleClient, StreamEvent } from '@/agent/api/openaiCompatibleClient'

// after
import { QueryEngine } from '@core/QueryEngine'
import type { OpenAICompatibleClient, StreamEvent } from '@core/OpenAICompatibleClient'
```

- [ ] **Step 5: 删空目录 `src/agent/`**

```bash
rmdir src/agent/api src/agent/query src/agent
```

如果 `src/agent` 已空，命令会成功；如果不空，先 ls 检查残留。

- [ ] **Step 6: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS（全部 19 个测试文件）

---

### Task 1.5: 搬 `registry.ts` 与 `fetchGet.ts` 到 agent-core

`registry.ts` 因为是 agent-core 的核心装配，搬到 `src/agent-core/ToolRegistry.ts`（同时改名以
反映对外身份）。`fetchGet.ts` 是唯一的"跨环境工具"，搬到 `src/agent-core/tools/fetchGet.ts`。
其它 chrome 工具（readPage 等）继续留在 `src/tools/`，PR 2 处理。

**Files:**
- Move: `src/tools/registry.ts` → `src/agent-core/ToolRegistry.ts`
- Move: `src/tools/fetchGet.ts` → `src/agent-core/tools/fetchGet.ts`
- Modify: 内部 import
- Modify: `src/extension/offscreen.ts`、`tests/tools/registry.test.ts`、
  `tests/tools/fetchGet.test.ts` 的 import

- [ ] **Step 1: git mv 两个文件**

```bash
git mv src/tools/registry.ts src/agent-core/ToolRegistry.ts
git mv src/tools/fetchGet.ts src/agent-core/tools/fetchGet.ts
```

- [ ] **Step 2: 改 `src/agent-core/ToolRegistry.ts` 内部 import**

```ts
import { toOpenAiTool } from './Tool'
import type { ToolDefinition } from './types'
```

- [ ] **Step 3: 改 `src/agent-core/tools/fetchGet.ts` 内部 import**

```ts
import { makeOk, makeError } from '../Tool'
import type { ToolDefinition } from '../types'
```

- [ ] **Step 4: 改 `src/extension/offscreen.ts` import**

```ts
import { ToolRegistry } from '@core/ToolRegistry'
import { fetchGetTool } from '@core/tools/fetchGet'
```

（`readPageTool` 等其它 5 个工具的 import 仍指向 `@/tools/...`，不动。）

- [ ] **Step 5: 改两个测试 import**

`tests/tools/registry.test.ts`：
```ts
import { ToolRegistry } from '@core/ToolRegistry'
```

`tests/tools/fetchGet.test.ts`：
```ts
import { fetchGetTool } from '@core/tools/fetchGet'
```

- [ ] **Step 6: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

---

### Task 1.6: 抽出 `AgentEvent` schema 到 `src/agent-core/protocol.ts`

`AgentEvent` 的对外形态由 agent-core 拥有，但要剥离当前的"传输 envelope（id/sessionId/ts）"
和"持久化 messageId"——那些是消费方的关注点。新的 `AgentEvent` 只表达"agent 内部发生了什么"，
没有 envelope。`extension/rpc/protocol.ts` 里的旧 `AgentEvent` 暂时保留，作为"wire 形态"，
内部由消费方在 emit 时把 agent-core 的 `AgentEvent` 包上 envelope。PR 1 不动 wire schema。

**Files:**
- Create: `src/agent-core/protocol.ts`

- [ ] **Step 1: 写 `src/agent-core/protocol.ts`**

```ts
import { z } from 'zod'

// agent-core 内部事件流。无 envelope（id/sessionId/ts）、无 messageId。
// 消费方（extension offscreen）拿到后再包 envelope 发到 wire。

const StreamChunk = z.object({
  kind: z.literal('message/streamChunk'),
  delta: z.string(),
})

const ToolStart = z.object({
  kind: z.literal('tool/start'),
  toolCall: z.object({
    id: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
})

const ToolEnd = z.object({
  kind: z.literal('tool/end'),
  toolCallId: z.string(),
  result: z.object({
    ok: z.boolean(),
    content: z.string(),
  }),
})

const Done = z.object({
  kind: z.literal('done'),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_iterations', 'cancel', 'error']),
  /** 完整 assistant 文本（done 时累计的全文）。给消费方持久化用。 */
  assistantText: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

const FatalError = z.object({
  kind: z.literal('fatalError'),
  code: z.string(),
  message: z.string(),
})

export const AgentEvent = z.discriminatedUnion('kind', [
  StreamChunk,
  ToolStart,
  ToolEnd,
  Done,
  FatalError,
])
export type AgentEvent = z.infer<typeof AgentEvent>
```

- [ ] **Step 2: typecheck（暂不改任何 import）**

Run: `bun run typecheck`
Expected: PASS（新文件未被任何代码 import）

---

### Task 1.7: 实现 `AgentSession` 与 `createAgent`

这是 agent-core 对外暴露的入口。`AgentSession` 封装 QueryEngine 调用、AbortController、把
EngineEvent 翻译成 AgentEvent。`createAgent` 是装配工厂。

**Files:**
- Create: `src/agent-core/AgentSession.ts`
- Create: `src/agent-core/createAgent.ts`
- Create: `src/agent-core/index.ts` (barrel)
- Test: `tests/agent-core/createAgent.test.ts`

- [ ] **Step 1: 创建 tests 目录与失败测试**

```bash
mkdir -p tests/agent-core
```

写 `tests/agent-core/createAgent.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createAgent } from '@core'
import type { OpenAICompatibleClient, StreamEvent } from '@core/OpenAICompatibleClient'

function fakeClient(scripts: StreamEvent[][]): OpenAICompatibleClient {
  let turn = 0
  return {
    async *streamChat() {
      const chunks = scripts[turn++] ?? []
      for (const c of chunks) yield c
    },
  } as any
}

describe('createAgent', () => {
  it('streams message/streamChunk events for assistant deltas and ends with done', async () => {
    const agent = createAgent({
      llmClient: fakeClient([[
        { kind: 'delta', text: 'Hello' },
        { kind: 'delta', text: ' world' },
        { kind: 'done', stopReason: 'stop' },
      ]]),
      tools: [],
      toolContext: {},
    })

    const events: any[] = []
    for await (const ev of agent.send('hi')) events.push(ev)

    const chunks = events.filter((e) => e.kind === 'message/streamChunk').map((e) => e.delta)
    expect(chunks.join('')).toBe('Hello world')

    const last = events[events.length - 1]
    expect(last.kind).toBe('done')
    expect(last.stopReason).toBe('end_turn')
    expect(last.assistantText).toBe('Hello world')
  })

  it('cancel() aborts the in-flight LLM call', async () => {
    let aborted = false
    const agent = createAgent({
      llmClient: {
        async *streamChat({ signal }: any) {
          signal?.addEventListener('abort', () => { aborted = true })
          await new Promise((r) => setTimeout(r, 30))
          yield { kind: 'done', stopReason: 'stop' } as StreamEvent
        },
      } as any,
      tools: [],
      toolContext: {},
    })

    const it = agent.send('hi')[Symbol.asyncIterator]()
    setTimeout(() => agent.cancel(), 5)
    while (!(await it.next()).done) {}
    expect(aborted).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `bun run test tests/agent-core/createAgent.test.ts`
Expected: FAIL — `Cannot find module '@core'` 或 `createAgent is not a function`

- [ ] **Step 3: 写 `src/agent-core/AgentSession.ts`**

```ts
import { QueryEngine } from './QueryEngine'
import type { OpenAICompatibleClient, ChatMessage } from './OpenAICompatibleClient'
import type { ToolDefinition, ToolExecContext, ToolResult, ToolCall } from './types'
import type { AgentEvent } from './protocol'
import { ToolRegistry } from './ToolRegistry'

export interface AgentSessionOptions<ExtraCtx = Record<string, never>> {
  llmClient: OpenAICompatibleClient
  registry: ToolRegistry
  toolContext: ExtraCtx
  systemPrompt?: string
  toolMaxIterations?: number
}

export class AgentSession<ExtraCtx = Record<string, never>> {
  private abort = new AbortController()
  private history: ChatMessage[] = []

  constructor(private opts: AgentSessionOptions<ExtraCtx>) {}

  cancel(): void {
    this.abort.abort()
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    this.history.push({ role: 'user', content: text })

    const engine = new QueryEngine({
      client: this.opts.llmClient,
      tools: this.opts.registry.toOpenAi(),
      executeTool: async (call: ToolCall) => {
        const def = this.opts.registry.get(call.name)
        if (!def) {
          return {
            ok: false,
            error: { code: 'unknown_tool', message: call.name, retryable: false },
          }
        }
        const ctx: ToolExecContext = {
          conversationId: '' as any,
          ...(this.opts.toolContext as object),
        }
        return def.execute(call.input as any, ctx)
      },
      toolMaxIterations: this.opts.toolMaxIterations,
      systemPrompt: this.opts.systemPrompt,
      signal: this.abort.signal,
    })

    let assistantText = ''

    for await (const ev of engine.run(this.history)) {
      if (ev.kind === 'assistant_delta') {
        assistantText += ev.text
        yield { kind: 'message/streamChunk', delta: ev.text }
      } else if (ev.kind === 'tool_executing') {
        yield {
          kind: 'tool/start',
          toolCall: { id: ev.call.id, tool: ev.call.name, args: ev.call.input },
        }
      } else if (ev.kind === 'tool_result') {
        yield {
          kind: 'tool/end',
          toolCallId: ev.callId,
          result: { ok: !ev.isError, content: ev.content },
        }
      } else if (ev.kind === 'done') {
        const stopReason =
          ev.stopReason === 'end_turn'
            ? 'end_turn'
            : ev.stopReason === 'max_iterations'
              ? 'max_iterations'
              : ev.stopReason === 'cancel'
                ? 'cancel'
                : ev.stopReason === 'error'
                  ? 'error'
                  : 'end_turn'
        yield {
          kind: 'done',
          stopReason,
          assistantText,
          ...(ev.error ? { error: ev.error } : {}),
        }
      }
    }
  }
}
```

注意：`conversationId: '' as any` 是过渡——agent-core 的 ctx 还有这字段（兼容 deprecated），
PR 2 删除字段时会一起清理。当前 fetchGet 不读 conversationId，扩展工具会通过
`toolContext` 把真实值塞进来。

- [ ] **Step 4: 写 `src/agent-core/createAgent.ts`**

```ts
import { AgentSession, type AgentSessionOptions } from './AgentSession'
import { OpenAICompatibleClient } from './OpenAICompatibleClient'
import { ToolRegistry } from './ToolRegistry'
import type { ToolDefinition } from './types'

export interface CreateAgentOptions<ExtraCtx = Record<string, never>> {
  /** OpenAI-compatible 配置；二选一：llm（自动构造 client）或 llmClient（自带实例，便于测试） */
  llm?: { apiKey: string; baseUrl: string; model: string }
  llmClient?: OpenAICompatibleClient
  /**
   * 工具数组。第三泛型 `any` 故意放宽，允许混合 `ToolDefinition<I, O>`（基础 ctx）与
   * `ToolDefinition<I, O, ExtraCtx>`（特化 ctx）——前者忽略 ExtraCtx 字段，后者读取。
   * 注入的 toolContext 必须满足"读它的工具"所需的字段。
   */
  tools: Array<ToolDefinition<any, any, any>>
  toolContext: ExtraCtx
  systemPrompt?: string
  toolMaxIterations?: number
}

export function createAgent<ExtraCtx>(opts: CreateAgentOptions<ExtraCtx>): AgentSession<ExtraCtx> {
  const client = opts.llmClient ?? new OpenAICompatibleClient(opts.llm!)
  const registry = new ToolRegistry()
  for (const t of opts.tools) registry.register(t)
  return new AgentSession<ExtraCtx>({
    llmClient: client,
    registry,
    toolContext: opts.toolContext,
    systemPrompt: opts.systemPrompt,
    toolMaxIterations: opts.toolMaxIterations,
  })
}
```

- [ ] **Step 5: 写 `src/agent-core/index.ts` barrel**

```ts
export { createAgent, type CreateAgentOptions } from './createAgent'
export { AgentSession } from './AgentSession'
export { OpenAICompatibleClient, type ChatMessage, type StreamEvent } from './OpenAICompatibleClient'
export { QueryEngine, type EngineEvent } from './QueryEngine'
export { ToolRegistry } from './ToolRegistry'
export { toOpenAiTool, makeOk, makeError } from './Tool'
export { fetchGetTool } from './tools/fetchGet'
export { AgentEvent } from './protocol'
export type {
  ToolDefinition,
  ToolExecContext,
  ToolExecRpc,
  ToolResult,
  ToolCall,
  ToolCallId,
  ConversationId,
  MessageId,
  SkillId,
  ApprovalId,
  Uuid,
  Role,
  Message,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  ContentPart,
} from './types'
```

- [ ] **Step 6: 跑刚才的测试，确认通过**

Run: `bun run test tests/agent-core/createAgent.test.ts`
Expected: PASS（两个用例）

- [ ] **Step 7: 全量 typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

---

### Task 1.8: 重构 `offscreen.ts` 用 `createAgent`

把 `runChat()` 里手工拼装 `OpenAICompatibleClient` + `QueryEngine` + ctx + abort 的代码替换成
`createAgent`。事件循环改成读 AgentEvent，自己包 envelope 后 emit。

**Files:**
- Modify: `src/extension/offscreen.ts`

- [ ] **Step 1: 改 import**

把 offscreen.ts 顶部的 import 块整理成：

```ts
import { ClientCmd } from './rpc/protocol'
import { createAgent, type AgentEvent } from '@core'
import { readPageTool } from '@/tools/readPage'
import { readSelectionTool } from '@/tools/readSelection'
import { querySelectorTool } from '@/tools/querySelector'
import { screenshotTool } from '@/tools/screenshot'
import { listTabsTool } from '@/tools/listTabs'
import { fetchGetTool } from '@core/tools/fetchGet'
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
import type { ToolExecContext, ToolExecRpc } from '@core/types'
```

注意：旧的 `ToolRegistry` import、`OpenAICompatibleClient` import、`QueryEngine` import、
`ToolCall` import 都不再需要——`createAgent` 内部装配。

- [ ] **Step 2: 删除文件顶部的 registry 装配代码**

删除：

```ts
const registry = new ToolRegistry()
registry.register(readPageTool)
// ...
registry.register(fetchGetTool)
```

留 `let swPort` 和 `activeAborts` 不动。

- [ ] **Step 3: 改写 `runChat()`**

把整段 `runChat()` 替换成：

```ts
async function runChat(cmd: { sessionId: string; text: string }) {
  console.log('[mycli-web/offscreen] runChat start, text:', cmd.text)
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

  // ToolExecContext fields shared by all tools (chrome backend).
  const tabId = (await guessActiveTab())?.id
  const rpc: ToolExecRpc = {
    domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
    chromeApi: (method, args) => callChromeApi(method, args),
  }
  const toolContext: Partial<ToolExecContext> = {
    conversationId: cid,
    tabId,
    rpc,
  }

  const agent = createAgent({
    llm: { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model },
    tools: [
      fetchGetTool,
      readPageTool, readSelectionTool, querySelectorTool, screenshotTool, listTabsTool,
    ],
    toolContext,
    toolMaxIterations: settings.toolMaxIterations,
    systemPrompt: settings.systemPromptAddendum || undefined,
  })

  // Track this session's agent so chat/cancel can abort it.
  activeAborts.set(cmd.sessionId, { abort: () => agent.cancel() } as any)

  const assistantMsg = await appendMessage({
    conversationId: cid,
    role: 'assistant',
    content: '',
    pending: true,
  })

  try {
    for await (const ev of agent.send(cmd.text)) {
      if (ev.kind === 'message/streamChunk') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/streamChunk',
          messageId: assistantMsg.id,
          delta: ev.delta,
        })
      } else if (ev.kind === 'tool/start') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/start',
          toolCall: ev.toolCall,
        })
      } else if (ev.kind === 'tool/end') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'tool/end',
          toolCallId: ev.toolCallId,
          result: ev.result,
        })
      } else if (ev.kind === 'done') {
        await updateMessage(assistantMsg.id, {
          content: ev.assistantText,
          pending: false,
        })
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'message/appended',
          message: {
            id: assistantMsg.id,
            role: 'assistant',
            content: ev.assistantText,
            createdAt: assistantMsg.createdAt,
          },
        })
      } else if (ev.kind === 'fatalError') {
        emit({
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'fatalError',
          code: ev.code,
          message: ev.message,
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
```

- [ ] **Step 4: 改 `activeAborts` 类型与 `chat/cancel` 处理**

把 `activeAborts` 的值类型从 `AbortController` 改成更宽松的 `{ abort: () => void }`：

```ts
const activeAborts = new Map<string, { abort: () => void }>()
```

`handleClientCmd` 里 `chat/cancel` 分支保持 `ac.abort()`：

```ts
case 'chat/cancel':
  for (const [, ac] of activeAborts) ac.abort()
  activeAborts.clear()
  return
```

`runChat` 里塞入 abort 包装：

```ts
activeAborts.set(cmd.sessionId, { abort: () => agent.cancel() })
```

`port.onDisconnect` 处的清理同样调 `ac.abort()`，因为接口仍然兼容。

- [ ] **Step 5: 跑全量测试**

Run: `bun run typecheck && bun run test`
Expected: PASS

- [ ] **Step 6: 手工冒烟（必要时）**

```bash
bun run build
```

加载 `dist/` 到 `chrome://extensions`（已加载过的话直接 reload），开任意页面，触发 FAB，
配 OpenAI key 后聊天 → 应能流式输出。

---

### Task 1.9: 删除 `src/shared/types.ts`，改剩余 `@shared/types` 引用为 `@core`

**Files:**
- Delete: `src/shared/types.ts`
- Modify: 所有还在用 `@shared/types` 的文件

- [ ] **Step 1: grep 出所有 `@shared/types` 引用**

Run: `grep -rn "from '@shared/types'" src tests --include='*.ts' --include='*.tsx'`

预期看到约 12 处（storage 文件、tools 文件、可能 offscreen 残留）。

- [ ] **Step 2: 批量替换**

把所有 `from '@shared/types'` 改为 `from '@core'`。例如
`src/extension/storage/messages.ts`：

```ts
import type { ConversationId, MessageId, Role } from '@core'
```

`src/tools/readPage.ts`：

```ts
import type { ToolDefinition } from '@core'
```

- [ ] **Step 3: 删除 `src/shared/types.ts`**

```bash
rm src/shared/types.ts
```

如果 `src/shared/` 还有其他文件就保留目录，否则删空目录：
```bash
rmdir src/shared 2>/dev/null || true
```

- [ ] **Step 4: 删除 `tsconfig.json` 与 vite/vitest 里的 `@shared` 别名**

`tsconfig.json` 的 `paths` 删掉 `"@shared/*"` 行；`vite.config.ts` 与 `vitest.config.ts` 的
`resolve.alias` 同步删掉 `'@shared': ...` 行。

- [ ] **Step 5: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

---

### Task 1.10: 引入 TS project references

**Files:**
- Create: `tsconfig.base.json`
- Modify: `tsconfig.json`（顶层变成聚合）
- Create: `src/agent-core/tsconfig.json`
- Create: `src/extension/tsconfig.json`
- Modify: `package.json`（typecheck script）

- [ ] **Step 1: 创建 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "allowImportingTsExtensions": false,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@ext/*": ["./src/extension/*"],
      "@core": ["./src/agent-core/index.ts"],
      "@core/*": ["./src/agent-core/*"]
    }
  }
}
```

- [ ] **Step 2: 替换顶层 `tsconfig.json`**

```json
{
  "files": [],
  "references": [
    { "path": "./src/agent-core" },
    { "path": "./src/extension" },
    { "path": "./tests" }
  ]
}
```

注意：tests 也要有 tsconfig 才能被 typecheck 覆盖。下面也加。

- [ ] **Step 3: 写 `src/agent-core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../../node_modules/.cache/tsc/agent-core",
    "types": ["vite/client"]
  },
  "include": ["**/*.ts"]
}
```

关键：`types: ["vite/client"]` 不含 `"chrome"` —— 这是边界守卫的核心。

- [ ] **Step 4: 写 `src/extension/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../../node_modules/.cache/tsc/extension",
    "types": ["chrome", "vite/client"]
  },
  "references": [
    { "path": "../agent-core" }
  ],
  "include": ["**/*.ts", "**/*.tsx"]
}
```

`src/tools/` 当前还在（PR 2 才搬），它的文件需要 chrome 类型。把它加进 `extension/tsconfig.json`
的 include 中，或者放一个临时 `src/tools/tsconfig.json`：

最简单：把 `src/tools/` 文件并入 `src/extension/tsconfig.json` 的 include：

```json
"include": ["**/*.ts", "**/*.tsx", "../tools/**/*.ts"]
```

——这是过渡态，PR 2 把工具搬走后这条 `../tools/` 就移除。

- [ ] **Step 5: 写 `tests/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../node_modules/.cache/tsc/tests",
    "types": ["chrome", "vite/client", "vitest/globals"]
  },
  "references": [
    { "path": "../src/agent-core" },
    { "path": "../src/extension" }
  ],
  "include": ["**/*.ts", "**/*.tsx"]
}
```

- [ ] **Step 6: 改 `package.json` typecheck 脚本**

```json
"typecheck": "tsc -b"
```

- [ ] **Step 7: 跑 typecheck**

Run: `bun run typecheck`
Expected: PASS。如果报 `Cannot find name 'chrome'` 在 `src/agent-core/` 内部，那是真违规（应该
没有，因为 fetchGet 是 chrome-free）；其它地方的 `chrome` 引用都在 extension 子项目内，应通过。

- [ ] **Step 8: 跑 tests**

Run: `bun run test`
Expected: PASS

- [ ] **Step 9: 边界自验证**

Run: `grep -rn "chrome\\." src/agent-core --include='*.ts'`
Expected: 零结果（agent-core 不应出现任何 chrome.xxx 引用）

---

### Task 1.11: PR 1 收尾——commit

- [ ] **Step 1: git status 确认变更**

Run: `git status` 与 `git diff --stat`

预期看到：
- 新增 `src/agent-core/` 目录及其下 8-9 个 .ts 文件 + tsconfig.json
- 新增 `tsconfig.base.json`、`src/extension/tsconfig.json`、`tests/tsconfig.json`
- 新增 `tests/agent-core/createAgent.test.ts`
- 修改顶层 `tsconfig.json`、`vite.config.ts`、`vitest.config.ts`、`package.json`
- 修改 `src/extension/offscreen.ts`、`src/extension/storage/*.ts`、`src/tools/*.ts`
- 删除 `src/agent/`、`src/shared/types.ts`

- [ ] **Step 2: 最后一次跑 typecheck + tests + build**

Run: `bun run typecheck && bun run test && bun run build`
Expected: 三个都 PASS

- [ ] **Step 3: commit**

```bash
git add -A
git commit -m "refactor: extract agent-core as internal module + createAgent factory

- Move QueryEngine / OpenAICompatibleClient / ToolRegistry / Tool helpers /
  fetchGet / agent types to src/agent-core/.
- Add createAgent({ llm, tools, toolContext }) factory and AgentSession that
  encapsulates engine.run + AbortController + EngineEvent → AgentEvent translation.
- Define agent-core's own AgentEvent zod schema (no envelope, no messageId);
  offscreen.ts wraps with envelope when emitting on the SW port.
- Set up TypeScript project references: agent-core/tsconfig.json drops
  @types/chrome — any chrome.* reference inside agent-core fails typecheck.
- Refactor offscreen.ts to use createAgent instead of manual wiring.
- Retire @shared/types alias; agent types now live in @core barrel.
- Chrome-specific tools (readPage / readSelection / querySelector / screenshot /
  listTabs) and DomOp schema remain at their current locations — they migrate
  in PR 2 along with ExtensionToolCtx.

Spec: docs/superpowers/specs/2026-05-07-agent-core-extraction-design.md"
```

---

## 阶段 2（PR 2）：extension-tools 抽取 + ToolExecContext 清理

进入条件：阶段 1 已 commit，main 上 build / test 全绿。
退出条件：所有 chrome 工具住在 `src/extension-tools/`、`ToolExecContext` 不再有 `tabId`/`rpc`/`exec`、
`src/tools/` 与 `src/extension/content/domHandlers.ts` 删除、tests 全过、扩展手工冒烟通过。

### Task 2.1: 加 `@ext-tools` 别名 + 创建 extension-tools 空壳

**Files:**
- Modify: `tsconfig.base.json`、`vite.config.ts`、`vitest.config.ts`
- Create: `src/extension-tools/.gitkeep`

- [ ] **Step 1: 加 `@ext-tools` alias 到 `tsconfig.base.json`**

```json
"paths": {
  "@/*": ["./src/*"],
  "@ext/*": ["./src/extension/*"],
  "@core": ["./src/agent-core/index.ts"],
  "@core/*": ["./src/agent-core/*"],
  "@ext-tools": ["./src/extension-tools/index.ts"],
  "@ext-tools/*": ["./src/extension-tools/*"]
}
```

- [ ] **Step 2: 加 `@ext-tools` alias 到 `vite.config.ts` 与 `vitest.config.ts`**

两处 `resolve.alias` 都加：
```ts
'@ext-tools': path.resolve(__dirname, 'src/extension-tools/index.ts'),
'@ext-tools/': path.resolve(__dirname, 'src/extension-tools/') + '/',
```

- [ ] **Step 3: 创建空目录**

```bash
mkdir -p src/extension-tools/tools src/extension-tools/content
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: PASS

---

### Task 2.2: 创建 `ExtensionToolCtx` / `ExtensionToolRpc` 类型 + DomOp schema

**Files:**
- Create: `src/extension-tools/ctx.ts`
- Create: `src/extension-tools/DomOp.ts`

- [ ] **Step 1: 写 `src/extension-tools/ctx.ts`**

```ts
import type { ToolResult, ConversationId } from '@core'

export interface ExtensionToolRpc {
  domOp(op: unknown, timeoutMs?: number): Promise<ToolResult>
  chromeApi(method: string, args: unknown[]): Promise<ToolResult>
}

export interface ExtensionToolCtx {
  rpc: ExtensionToolRpc
  tabId?: number
  conversationId?: ConversationId
}
```

- [ ] **Step 2: 写 `src/extension-tools/DomOp.ts`**

把 `src/extension/rpc/protocol.ts` 里 `DomReadPage` / `DomClick` / `DomType` / `DomScreenshot`
和 `DomOp` discriminatedUnion 整段搬过来：

```ts
import { z } from 'zod'

const Base = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  ts: z.number().int().nonnegative(),
})

const DomReadPage = Base.extend({
  kind: z.literal('dom/readPage'),
  tabId: z.number().int(),
  mode: z.enum(['text', 'markdown', 'html-simplified']),
})

const DomClick = Base.extend({
  kind: z.literal('dom/click'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string(), all: z.boolean().optional() }),
})

const DomType = Base.extend({
  kind: z.literal('dom/type'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string() }),
  value: z.string(),
})

const DomScreenshot = Base.extend({
  kind: z.literal('dom/screenshot'),
  tabId: z.number().int(),
})

export const DomOp = z.discriminatedUnion('kind', [
  DomReadPage,
  DomClick,
  DomType,
  DomScreenshot,
])
export type DomOp = z.infer<typeof DomOp>
```

- [ ] **Step 3: 修 `src/extension/rpc/protocol.ts`**

删除 `DomReadPage` / `DomClick` / `DomType` / `DomScreenshot` / `DomOp` 定义，并把
`Envelope` 中 `payload` 的 `union([ClientCmd, AgentEvent, DomOp])` 改成
`union([ClientCmd, AgentEvent])`（Envelope 不再覆盖 dom op 路径——本来 `dom/*` 就走另一条
sendMessage 通道，没必要在 Envelope 里）：

```ts
import { z } from 'zod'
import { ClientCmd as ClientCmdSchema } from './ClientCmdMaybe' // see下面
// 或保持 ClientCmd / AgentEvent 在本文件，仅删 DomOp 部分
```

实操：保留 `ClientCmd`、`AgentEvent`（wire 形态）原状，仅删除 `Dom*` 节与从 `Envelope.payload`
里去掉 `DomOp`：

```ts
export const Envelope = z.object({
  direction: z.enum([
    'client->offscreen',
    'offscreen->client',
    'offscreen->content',
    'content->offscreen',
  ]),
  payload: z.union([ClientCmd, AgentEvent]),
})
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: PASS（DomOp 没有任何运行时引用——它只在协议文件中被引用为 schema；如果 typecheck
报某处 import `DomOp` from extension/rpc，把那处 import 改到 `@ext-tools/DomOp`）

---

### Task 2.3: 搬 chrome 工具到 extension-tools（保持 ctx 形态不变）

**Files:**
- Move: `src/tools/{readPage,readSelection,querySelector,screenshot,listTabs}.ts` → `src/extension-tools/tools/`
- Modify: 工具文件内部 import + `ToolDefinition` 第三泛型改为 `ExtensionToolCtx`

- [ ] **Step 1: git mv 五个工具**

```bash
git mv src/tools/readPage.ts src/extension-tools/tools/readPage.ts
git mv src/tools/readSelection.ts src/extension-tools/tools/readSelection.ts
git mv src/tools/querySelector.ts src/extension-tools/tools/querySelector.ts
git mv src/tools/screenshot.ts src/extension-tools/tools/screenshot.ts
git mv src/tools/listTabs.ts src/extension-tools/tools/listTabs.ts
```

- [ ] **Step 2: 改 `src/extension-tools/tools/readPage.ts`**

```ts
import { makeError } from '@core/Tool'
import type { ToolDefinition } from '@core'
import type { ExtensionToolCtx } from '../ctx'

interface ReadPageInput {
  mode?: 'text' | 'markdown' | 'html-simplified'
}

interface ReadPageOutput {
  text: string
  url?: string
  title?: string
}

export const readPageTool: ToolDefinition<ReadPageInput, ReadPageOutput, ExtensionToolCtx> = {
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
  async execute(input, ctx) {
    if (ctx.tabId === undefined) {
      return makeError('no_active_tab', 'no active tab to read from')
    }
    const mode = input.mode ?? 'text'
    return (await ctx.rpc.domOp(
      { kind: 'dom/readPage', tabId: ctx.tabId, mode },
      30_000,
    )) as any
  },
}
```

注意：删除了 `exec: 'content'` 字段（PR 2 起此字段从 `ToolDefinition` 删除），第三泛型加上
`ExtensionToolCtx`。

- [ ] **Step 3: 同样改 `readSelection.ts`、`querySelector.ts`、`screenshot.ts`、`listTabs.ts`**

每个文件：
- 顶部 import 加 `import type { ExtensionToolCtx } from '../ctx'`
- `ToolDefinition<I, O>` 改成 `ToolDefinition<I, O, ExtensionToolCtx>`
- 删除 `exec: 'content'|'sw'` 字段
- 函数体不动（仍用 `ctx.rpc.domOp / ctx.rpc.chromeApi / ctx.tabId`）

- [ ] **Step 4: 改 `ToolDefinition` 第三泛型支持**

`src/agent-core/types.ts` 的 `ToolDefinition` 接口加第三泛型参数：

```ts
export interface ToolDefinition<I = unknown, O = unknown, ExtraCtx = Record<string, never>> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: I, ctx: ToolExecContext & ExtraCtx): Promise<ToolResult<O>>
}
```

把 deprecated `exec` 字段删掉（PR 2 起执行位置由"工具来自哪个包"决定）。

- [ ] **Step 5: 更新 `tests/tools/readPage.test.ts` 的 import 与 ctx 类型**

PR 1 Task 1.9 已经把它的 `@shared/types` → `@core`；现在再改两件事：

```ts
// before
import { readPageTool } from '@/tools/readPage'
import type { ToolExecContext } from '@core'

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

// after
import { readPageTool } from '@ext-tools/tools/readPage'
import type { ExtensionToolCtx } from '@ext-tools'

function makeCtx(overrides: Partial<ExtensionToolCtx> = {}): ExtensionToolCtx {
  return {
    tabId: 42,
    rpc: {
      domOp: vi.fn().mockResolvedValue({ ok: true, data: { text: 'hello world' } }),
      chromeApi: vi.fn(),
    },
    conversationId: 'conv1',
    ...overrides,
  }
}
```

测试体里 `readPageTool.execute(input, ctx)` 调用不变（ctx 形状一致）。

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: 可能会报 `src/extension/offscreen.ts` 的 `tools` 数组类型不一致——Task 2.5 修。
其它处应通过。

---

### Task 2.4: 搬 `domHandlers.ts` 到 extension-tools

**Files:**
- Move: `src/extension/content/domHandlers.ts` → `src/extension-tools/content/domHandlers.ts`
- Modify: content script 的 import

- [ ] **Step 1: git mv**

```bash
git mv src/extension/content/domHandlers.ts src/extension-tools/content/domHandlers.ts
```

- [ ] **Step 2: 找 import 站点**

Run: `grep -rn "domHandlers" src/extension --include='*.ts' --include='*.tsx'`

- [ ] **Step 3: 改 import 路径**

每处 `from '@/extension/content/domHandlers'` 或类似，改为 `from '@ext-tools/content/domHandlers'`。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 仍有 offscreen.ts 报错（Task 2.5 修）；其它通过

---

### Task 2.5: 创建 `extension-tools/index.ts` barrel + 改 offscreen.ts

**Files:**
- Create: `src/extension-tools/index.ts`
- Modify: `src/extension/offscreen.ts`

- [ ] **Step 1: 写 `src/extension-tools/index.ts`**

```ts
export type { ExtensionToolCtx, ExtensionToolRpc } from './ctx'
export { DomOp } from './DomOp'
export { readPageTool } from './tools/readPage'
export { readSelectionTool } from './tools/readSelection'
export { querySelectorTool } from './tools/querySelector'
export { screenshotTool } from './tools/screenshot'
export { listTabsTool } from './tools/listTabs'

import { readPageTool } from './tools/readPage'
import { readSelectionTool } from './tools/readSelection'
import { querySelectorTool } from './tools/querySelector'
import { screenshotTool } from './tools/screenshot'
import { listTabsTool } from './tools/listTabs'

/** All chrome-extension-only tools, ready to register on a chrome-backed agent. */
export const extensionTools = [
  readPageTool,
  readSelectionTool,
  querySelectorTool,
  screenshotTool,
  listTabsTool,
]
```

- [ ] **Step 2: 改 `src/extension/offscreen.ts` import**

```ts
import { fetchGetTool } from '@core/tools/fetchGet'
import { extensionTools, type ExtensionToolCtx, type ExtensionToolRpc } from '@ext-tools'
```

删除原来逐个 import 的 `readPageTool` 等五行。

- [ ] **Step 3: 改 offscreen.ts 的 toolContext 装配**

把 `runChat` 里：

```ts
const rpc: ToolExecRpc = { ... }
const toolContext: Partial<ToolExecContext> = {
  conversationId: cid,
  tabId,
  rpc,
}
```

改成：

```ts
const rpc: ExtensionToolRpc = {
  domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
  chromeApi: (method, args) => callChromeApi(method, args),
}
const toolContext: ExtensionToolCtx = {
  rpc,
  tabId,
  conversationId: cid,
}
```

- [ ] **Step 4: 改 `tools` 数组**

```ts
tools: [fetchGetTool, ...extensionTools],
```

- [ ] **Step 5: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

注：`createAgent.ts` 的 `tools: Array<ToolDefinition<any, any, any>>` 已经允许异构数组，
`fetchGetTool`（第三泛型默认 `Record<string, never>`）与扩展工具
（`ToolDefinition<I, O, ExtensionToolCtx>`）混在同一数组里 typecheck 直接通过，无需 `as any`。

---

### Task 2.6: 清理 `agent-core/types.ts` 里的 deprecated 字段

**Files:**
- Modify: `src/agent-core/types.ts`

- [ ] **Step 1: 删除 deprecated 字段**

`ToolExecContext` 改成：

```ts
export interface ToolExecContext {
  /** PR 2: signal 暂未注入，未来可补 */
  signal?: AbortSignal
}
```

`ToolDefinition` 删掉 `exec` 字段（前面 Task 2.3 Step 4 已做）。

`ToolExecRpc` interface 整段删除（已搬到 `extension-tools/ctx.ts`）。

- [ ] **Step 2: 检查所有引用 ToolExecRpc 的地方**

Run: `grep -rn "ToolExecRpc" src tests --include='*.ts'`

预期只剩 `src/extension-tools/ctx.ts` 自己定义。其它全部应改完。

- [ ] **Step 3: 修 `src/agent-core/index.ts` barrel**

去掉 `ToolExecRpc` 导出：

```ts
export type {
  ToolDefinition,
  ToolExecContext,
  ToolResult,
  ToolCall,
  // ...
} from './types'
```

- [ ] **Step 4: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

---

### Task 2.7: 创建 `src/extension-tools/tsconfig.json` 并接入 references

**Files:**
- Create: `src/extension-tools/tsconfig.json`
- Modify: `src/extension/tsconfig.json`、顶层 `tsconfig.json`

- [ ] **Step 1: 写 `src/extension-tools/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../../node_modules/.cache/tsc/extension-tools",
    "types": ["chrome", "vite/client"]
  },
  "references": [
    { "path": "../agent-core" }
  ],
  "include": ["**/*.ts"]
}
```

- [ ] **Step 2: 修改 `src/extension/tsconfig.json`**

加 `extension-tools` 到 references；移除过渡用的 `"../tools/**/*.ts"` include（PR 1 临时加的）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../../node_modules/.cache/tsc/extension",
    "types": ["chrome", "vite/client"]
  },
  "references": [
    { "path": "../agent-core" },
    { "path": "../extension-tools" }
  ],
  "include": ["**/*.ts", "**/*.tsx"]
}
```

- [ ] **Step 3: 修改顶层 `tsconfig.json`**

加 `extension-tools`：

```json
{
  "files": [],
  "references": [
    { "path": "./src/agent-core" },
    { "path": "./src/extension-tools" },
    { "path": "./src/extension" },
    { "path": "./tests" }
  ]
}
```

- [ ] **Step 4: 修改 `tests/tsconfig.json`**

```json
"references": [
  { "path": "../src/agent-core" },
  { "path": "../src/extension-tools" },
  { "path": "../src/extension" }
]
```

- [ ] **Step 5: typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS

---

### Task 2.8: 删除空目录与边界自验证

**Files:**
- Delete: `src/tools/`（应该已经全空）
- Delete: `src/extension/content/domHandlers.ts` 占位（已 git mv 走）

- [ ] **Step 1: 检查 `src/tools/` 是否全空**

Run: `ls src/tools/`
Expected: 空。直接 `rmdir src/tools`。

- [ ] **Step 2: 检查 `src/extension/content/`**

Run: `ls src/extension/content/`
Expected: `domHandlers.ts` 已搬走；可能仍有 `index.tsx`、`ChatApp.tsx` 等。保留。

- [ ] **Step 3: 边界自验证**

```bash
grep -rn "chrome\\." src/agent-core --include='*.ts' && echo "VIOLATION" || echo "OK"
grep -rn "from '@ext\\|from '@ext-tools" src/agent-core --include='*.ts' && echo "VIOLATION" || echo "OK"
grep -rn "from '@ext'" src/extension-tools --include='*.ts' && echo "VIOLATION" || echo "OK"
```

Expected: 全部输出 "OK"。

- [ ] **Step 4: 移除 `src/tools/` 残留 alias**

`vite.config.ts` / `vitest.config.ts` 没有 `@/tools/...` 这样的 alias（用的是顶层 `@`），所以
不必额外改。但 `tsconfig.base.json` 的 `@/*` 还在——保留。

- [ ] **Step 5: 跑 build**

Run: `bun run build`
Expected: PASS（`dist/` 重新生成）

- [ ] **Step 6: 手工冒烟**

加载 `dist/` 到 chrome，配 API key，触发 FAB，发"读一下当前页面的标题"。Agent 应：
1. 流式输出 "我会调用 readPage 工具..."
2. 工具卡片显示 readPage 的 args
3. 工具卡片显示结果（页面文本片段）
4. 流式输出最终回答
5. UI 整体行为与 main 一致

---

### Task 2.9: PR 2 收尾——commit

- [ ] **Step 1: git status 确认**

Run: `git status` 与 `git diff --stat`

预期：
- 新增 `src/extension-tools/` 完整目录（ctx.ts、DomOp.ts、index.ts、tsconfig.json、tools/*.ts、content/domHandlers.ts）
- 修改 `src/agent-core/types.ts`、`src/agent-core/index.ts`（清理 deprecated）
- 修改 `src/extension/offscreen.ts`、`src/extension/rpc/protocol.ts`、
  `src/extension/content/index.tsx`（domHandlers 路径）
- 修改 `src/extension/tsconfig.json`、`tsconfig.json`、`tests/tsconfig.json`
- 修改 `tsconfig.base.json`、`vite.config.ts`、`vitest.config.ts`（@ext-tools alias）
- 删除 `src/tools/`、`src/extension/content/domHandlers.ts`

- [ ] **Step 2: 最后一次 typecheck + tests + build**

Run: `bun run typecheck && bun run test && bun run build`
Expected: 三个都 PASS

- [ ] **Step 3: commit**

```bash
git add -A
git commit -m "refactor: extract extension-tools + clean up ToolExecContext

- Move chrome-specific tools (readPage / readSelection / querySelector /
  screenshot / listTabs), DomOp zod schema, and content-script DOM handlers
  to src/extension-tools/.
- Define ExtensionToolCtx + ExtensionToolRpc in extension-tools/ctx.ts.
  Tool function bodies unchanged — they still call ctx.rpc.domOp /
  ctx.rpc.chromeApi exactly as before; only the type source moved.
- ToolDefinition gains a third generic ExtraCtx; extension tools are typed
  as ToolDefinition<I, O, ExtensionToolCtx>.
- Drop deprecated tabId / rpc / exec fields from agent-core ToolExecContext.
  agent-core's ctx is now just { signal? }; consumer-specific fields live in
  ExtraCtx.
- Add extension-tools as a TS project reference; src/extension/tsconfig.json
  no longer pulls src/tools/ via include.
- offscreen.ts now imports from @ext-tools and passes
  toolContext: { rpc: { domOp, chromeApi }, tabId, conversationId }.

Spec: docs/superpowers/specs/2026-05-07-agent-core-extraction-design.md"
```

---

## 验收清单（两阶段都跑完后）

- [ ] `grep -rn 'chrome\\.' src/agent-core --include='*.ts'` 零结果
- [ ] `grep -rn '@ext\\|@ext-tools' src/agent-core --include='*.ts'` 零结果
- [ ] `grep -rn '@ext\\b' src/extension-tools --include='*.ts'` 零结果（extension-tools 不应依赖 extension）
- [ ] `bun run typecheck` 通过（用 `tsc -b`）
- [ ] `bun run test` 全通过（19+ 个测试文件，包括新增的 createAgent 测试）
- [ ] `bun run build` 通过；`dist/` 加载到 chrome 后聊天 + 工具调用与 main 一致
- [ ] `src/agent/`、`src/shared/types.ts`、`src/tools/` 均已删除
- [ ] git history 中 `git log --follow src/agent-core/QueryEngine.ts` 能追到原 `src/agent/query/QueryEngine.ts`（git mv 保留 history）
