# TodoWrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-conversation todo list, maintained by the LLM via a single `todoWrite` tool that does full-list-replace. Todos persist to IndexedDB and surface via a `todo/updated` wire event so any browser-extension consumer can render them.

**Architecture:** Kernel-first. `TodoStoreAdapter` parallel to `MessageStoreAdapter` in `kernel/adapters/`. Kernel ships a default IDB implementation in `kernel/browser/storage/`. `todoWriteTool` lives in `kernel/core/tools/` and is auto-registered by `bootKernelOffscreen`. Wire event `todo/updated` carries the full list every time. Consumer is read-only.

**Tech Stack:** TypeScript / Bun / Vitest / Zod / IndexedDB (via `idb`) / React.

**Spec:** `docs/superpowers/specs/2026-05-13-todowrite-design.md`

**重要约束:**
- 守 `packages/mycli-web/CLAUDE.md`(OpenAI-compatible only)
- **kernel core/ 零 chrome 依赖**(都在 browser/ 下)
- TDD;每 task 一 commit;`cd <pkg-dir> && bun run <script>`(`bun --cwd` 不工作)
- 每改完一个 task: typecheck + 受影响 package 的 test 全绿 + consumer build OK

---

## File Map

**kernel — core/(零 chrome 依赖)**:

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/agent-kernel/src/core/types.ts` | 加 `TodoStatus`;`ToolExecContext` 加 `todoStore?` + `conversationId?` | ~10 |
| `packages/agent-kernel/src/core/tools/todoWrite.ts` | **新建** `todoWriteTool` | ~60 |
| `packages/agent-kernel/src/core/protocol.ts` | core `AgentEvent` 加 `TodoUpdated` Zod | ~15 |

**kernel — adapters/(纯类型)**:

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/agent-kernel/src/adapters/TodoStoreAdapter.ts` | **新建** `TodoItem` / `TodoWriteInput` / `TodoStoreAdapter` | ~30 |
| `packages/agent-kernel/src/adapters/index.ts` | 转出 todo types | ~5 |

**kernel — browser/(可 chrome.*)**:

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/agent-kernel/src/browser/storage/db.ts` | DB_VERSION 1→2;upgrade callback 加 `todos` object store;`MycliWebSchema` 加 `todos` 字段 | ~10 |
| `packages/agent-kernel/src/browser/storage/createIdbTodoStore.ts` | **新建** `TodoStoreAdapter` 的 IDB 实现 | ~80 |
| `packages/agent-kernel/src/browser/rpc/protocol.ts` | wire `AgentEvent` 加 `TodoUpdated` Zod | ~15 |
| `packages/agent-kernel/src/browser/agentService.ts` | `AgentServiceDeps` 加 `todoStore?`;ctx 注入;tool/end 后 emit `todo/updated`;chat/loadConversation 末尾 emit 初始 `todo/updated` | ~30 |
| `packages/agent-kernel/src/browser/bootKernelOffscreen.ts` | options 加 `todoStore?`;默认 `createIdbTodoStore`;auto-register `todoWriteTool` 到 tools 列表 | ~15 |
| `packages/agent-kernel/src/index.ts` | 导出新 symbols | ~10 |

**consumer — mycli-web**:

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/mycli-web/src/extension/ui/TodoList.tsx` | **新建** read-only React 组件 | ~70 |
| `packages/mycli-web/src/extension/content/ChatApp.tsx` | `todos` state + 订阅 `todo/updated` + 挂载 `<TodoList />` | ~10 |

**Tests**:

| 文件 | 改动 |
|---|---|
| `packages/agent-kernel/tests/core/tools/todoWrite.test.ts` | **新建** |
| `packages/agent-kernel/tests/core/protocol.test.ts` | 扩(core TodoUpdated Zod) |
| `packages/agent-kernel/tests/browser/storage/createIdbTodoStore.test.ts` | **新建** |
| `packages/agent-kernel/tests/core/protocol.test.ts` 或新文件 | 扩(wire TodoUpdated Zod — 与上面同文件因为现状即是) |
| `packages/agent-kernel/tests/browser/agentService.test.ts` | 扩(emit on todoWrite tool/end + loadConversation 初始 emit) |
| `packages/mycli-web/tests/extension/ui/TodoList.test.tsx` | **新建** |

---

## Task 1: Types + Adapter interface + `todoWriteTool` + tool tests

**Files:**
- Modify: `packages/agent-kernel/src/core/types.ts`(加 `TodoStatus`;`ToolExecContext` 加 2 字段)
- Create: `packages/agent-kernel/src/adapters/TodoStoreAdapter.ts`
- Modify: `packages/agent-kernel/src/adapters/index.ts`(转出)
- Create: `packages/agent-kernel/src/core/tools/todoWrite.ts`
- Modify: `packages/agent-kernel/src/index.ts`(导出)
- Create: `packages/agent-kernel/tests/core/tools/todoWrite.test.ts`

- [ ] **Step 1: Write failing tests for `todoWriteTool`**

```ts
// packages/agent-kernel/tests/core/tools/todoWrite.test.ts
import { describe, it, expect, vi } from 'vitest'
import { todoWriteTool, type TodoStoreAdapter, type TodoItem } from 'agent-kernel'

const stubStore = (overrides: Partial<TodoStoreAdapter> = {}): TodoStoreAdapter => ({
  list: vi.fn().mockResolvedValue([]),
  replace: vi.fn().mockResolvedValue([]),
  ...overrides,
})

describe('todoWriteTool', () => {
  it('calls store.replace with conversationId and items, returns canonical state', async () => {
    const canonical: TodoItem[] = [
      { id: 't1', subject: 'A', status: 'pending', createdAt: 1, updatedAt: 2 },
    ]
    const store = stubStore({ replace: vi.fn().mockResolvedValue(canonical) })
    const res = await todoWriteTool.execute(
      { items: [{ subject: 'A', status: 'pending' }] },
      { todoStore: store, conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.count).toBe(1)
      expect(res.data.items).toEqual(canonical)
    }
    expect(store.replace).toHaveBeenCalledWith('c1', [{ subject: 'A', status: 'pending' }])
  })

  it('returns makeError when todoStore is missing', async () => {
    const res = await todoWriteTool.execute(
      { items: [] },
      { conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('todo_unavailable')
    }
  })

  it('returns makeError when conversationId is missing (ephemeral turn)', async () => {
    const store = stubStore()
    const res = await todoWriteTool.execute(
      { items: [] },
      { todoStore: store } as any,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('no_conversation')
    }
    expect(store.replace).not.toHaveBeenCalled()
  })

  it('accepts an empty items array (clears the list)', async () => {
    const store = stubStore({ replace: vi.fn().mockResolvedValue([]) })
    const res = await todoWriteTool.execute(
      { items: [] },
      { todoStore: store, conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.count).toBe(0)
      expect(res.data.items).toEqual([])
    }
    expect(store.replace).toHaveBeenCalledWith('c1', [])
  })

  it('propagates store.replace errors as makeError', async () => {
    const store = stubStore({
      replace: vi.fn().mockRejectedValue(new Error('idb boom')),
    })
    const res = await todoWriteTool.execute(
      { items: [{ subject: 'A', status: 'pending' }] },
      { todoStore: store, conversationId: 'c1' } as any,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('todo_persist_failed')
      expect(res.error.message).toMatch(/idb boom/)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/agent-kernel && bun run test tests/core/tools/todoWrite.test.ts
```
Expected: FAIL — `todoWriteTool` / `TodoStoreAdapter` / `TodoItem` not exported.

- [ ] **Step 3: Add `TodoStatus` + `ToolExecContext` fields to `core/types.ts`**

Find the existing `ToolExecContext` interface(~line 67):

```ts
export interface ToolExecContext {
  signal?: AbortSignal
}
```

Change to:

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface ToolExecContext {
  signal?: AbortSignal
  /** Per-conversation todo store. Injected by agentService for tools that need it. */
  todoStore?: import('../adapters/TodoStoreAdapter').TodoStoreAdapter
  /** Active conversation id. Undefined for ephemeral turns. */
  conversationId?: ConversationId
}
```

(Use `import('...')` inline type import to avoid a circular import at module level — adapters/TodoStoreAdapter imports from core/types for `TodoStatus` + `ConversationId`, but core/types imports adapter as type-only inline.)

- [ ] **Step 4: Create `adapters/TodoStoreAdapter.ts`**

```ts
// packages/agent-kernel/src/adapters/TodoStoreAdapter.ts
import type { ConversationId, TodoStatus } from '../core/types'

export interface TodoItem {
  id: string
  subject: string
  status: TodoStatus
  description?: string
  activeForm?: string
  createdAt: number
  updatedAt: number
}

export type TodoWriteInput = {
  /** Provide to preserve existing item's createdAt + id. Omit for new items. */
  id?: string
  subject: string
  status: TodoStatus
  description?: string
  activeForm?: string
}

export interface TodoStoreAdapter {
  /** List current todos for a conversation. Empty array if none. */
  list(conversationId: ConversationId): Promise<TodoItem[]>
  /**
   * Atomically replace the entire list. Items WITH id preserve original
   * createdAt + id; new items get fresh uuid + createdAt. updatedAt is
   * bumped on every replace for every item in the new list (no content-
   * diff heuristic — semantics are intentionally simple). Items absent
   * from input are removed. Returns the canonical post-replace state.
   */
  replace(
    conversationId: ConversationId,
    items: TodoWriteInput[],
  ): Promise<TodoItem[]>
}
```

- [ ] **Step 5: Re-export from `adapters/index.ts`**

Append to the existing `adapters/index.ts`:

```ts
export type {
  TodoItem,
  TodoWriteInput,
  TodoStoreAdapter,
} from './TodoStoreAdapter'
```

- [ ] **Step 6: Create `core/tools/todoWrite.ts`**

```ts
// packages/agent-kernel/src/core/tools/todoWrite.ts
import type { ToolDefinition } from '../types'
import type { TodoItem, TodoWriteInput } from '../../adapters/TodoStoreAdapter'
import { makeOk, makeError } from '../Tool'

export const todoWriteTool: ToolDefinition<
  { items: TodoWriteInput[] },
  { count: number; items: TodoItem[] },
  Record<string, never>
> = {
  name: 'todoWrite',
  description: `Replace the active conversation's todo list. This tool is
full-list-replace: pass the ENTIRE intended new state — items missing from
your input are deleted, items with id preserve their original createdAt,
items without id become new entries.

Use this when working on a multi-step task (3+ distinct steps). Mark items
in_progress while working on them; never have more than one in_progress at
a time. The list is per-conversation and persists across page reloads.`,
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            description: { type: 'string' },
            activeForm: { type: 'string' },
          },
          required: ['subject', 'status'],
        },
      },
    },
    required: ['items'],
  },
  async execute({ items }, ctx) {
    if (!ctx.todoStore) {
      return makeError('todo_unavailable', 'todoStore not configured for this agent')
    }
    if (!ctx.conversationId) {
      return makeError('no_conversation', 'todoWrite requires an active conversation')
    }
    try {
      const result = await ctx.todoStore.replace(ctx.conversationId, items)
      return makeOk({ count: result.length, items: result })
    } catch (e) {
      return makeError(
        'todo_persist_failed',
        e instanceof Error ? e.message : String(e),
      )
    }
  },
}
```

- [ ] **Step 7: Export new symbols from `index.ts`**

Find the existing `adapters` export block in `packages/agent-kernel/src/index.ts`:

```ts
export type {
  Settings,
  SettingsAdapter,
  MessageStoreAdapter,
  MessageRecord,
  AppendMessageInput,
  AppendedMessage,
  ToolContextBuilder,
} from './adapters'
```

Extend with todo types:

```ts
export type {
  Settings,
  SettingsAdapter,
  MessageStoreAdapter,
  MessageRecord,
  AppendMessageInput,
  AppendedMessage,
  ToolContextBuilder,
  TodoItem,
  TodoWriteInput,
  TodoStoreAdapter,
} from './adapters'
```

Find the existing `core: agent loop & 协议` block and add `TodoStatus`:

```ts
export type {
  // ...existing
  TodoStatus,
} from './core/types'
```

(If TodoStatus isn't already in the existing type export from `./core/types`, add it. Otherwise it goes in a sibling block.)

Add tools export alongside `fetchGetTool`:

```ts
export { fetchGetTool } from './core/tools/fetchGet'
export { todoWriteTool } from './core/tools/todoWrite'
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd packages/agent-kernel && bun run test tests/core/tools/todoWrite.test.ts
```
Expected: 5 cases PASS.

- [ ] **Step 9: Full kernel typecheck + tests**

From worktree root:
```bash
bun run typecheck
cd packages/agent-kernel && bun run test
```
Expected: typecheck clean. 286 (baseline post-#2) + 5 = 291 tests green.

- [ ] **Step 10: Commit**

```bash
git add packages/agent-kernel/src/core/types.ts \
        packages/agent-kernel/src/adapters/TodoStoreAdapter.ts \
        packages/agent-kernel/src/adapters/index.ts \
        packages/agent-kernel/src/core/tools/todoWrite.ts \
        packages/agent-kernel/src/index.ts \
        packages/agent-kernel/tests/core/tools/todoWrite.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): TodoStoreAdapter interface + todoWriteTool

Adds the kernel-level types and tool for per-conversation todo lists.
TodoStoreAdapter mirrors MessageStoreAdapter — kernel ships an interface,
consumer-or-default provides the implementation. todoWriteTool does
full-list-replace via ctx.todoStore.replace(ctx.conversationId, items)
with makeError fallbacks for missing store / missing conversation / IDB
failure. Pure TS, zero chrome dependency.

Default IDB-backed adapter + tool wiring + wire event come in later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: core + wire protocol `TodoUpdated` Zod

**Files:**
- Modify: `packages/agent-kernel/src/core/protocol.ts`(加 core `TodoUpdated`)
- Modify: `packages/agent-kernel/src/browser/rpc/protocol.ts`(加 wire `TodoUpdated`)
- Modify: `packages/agent-kernel/tests/core/protocol.test.ts`(扩 — file currently tests BOTH core and wire schemas)

- [ ] **Step 1: Write failing tests**

The file `tests/core/protocol.test.ts` already imports both `AgentEvent as CoreAgentEvent` and `WireAgentEvent as AgentEvent` from `'agent-kernel'`. Append at the end of the file:

```ts
describe('Core AgentEvent — todo/updated', () => {
  it('accepts todo/updated with full item shape', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'todo/updated',
      conversationId: 'conv-1',
      items: [
        {
          id: 't1',
          subject: 'Write tests',
          status: 'pending',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts todo/updated with empty items', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'todo/updated',
      conversationId: 'conv-1',
      items: [],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects todo/updated with invalid status', () => {
    const parsed = CoreAgentEvent.safeParse({
      kind: 'todo/updated',
      conversationId: 'conv-1',
      items: [
        {
          id: 't1',
          subject: 'x',
          status: 'archived',  // not in enum
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('Wire AgentEvent — todo/updated', () => {
  it('accepts wire todo/updated with envelope + items', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'todo/updated',
      conversationId: '33333333-3333-4333-8333-333333333333',
      items: [
        {
          id: 't1',
          subject: 'A',
          status: 'in_progress',
          activeForm: 'Doing A',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts wire todo/updated with empty items', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'todo/updated',
      conversationId: '33333333-3333-4333-8333-333333333333',
      items: [],
    })
    expect(parsed.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm fail**

```bash
cd packages/agent-kernel && bun run test tests/core/protocol.test.ts
```
Expected: 5 new cases FAIL — neither schema knows `todo/updated`.

- [ ] **Step 3: Add `TodoUpdated` to `core/protocol.ts`**

Locate the existing `AgentEvent` discriminated union near the end of `packages/agent-kernel/src/core/protocol.ts`. Before the `export const AgentEvent = z.discriminatedUnion(...)` line, define:

```ts
// Per-conversation todo list snapshot. Emitted by agentService after every
// successful todoWriteTool call and on conversation switch.
const TodoUpdated = z.object({
  kind: z.literal('todo/updated'),
  conversationId: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed']),
      description: z.string().optional(),
      activeForm: z.string().optional(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
    }),
  ),
})
```

Add `TodoUpdated` to the `AgentEvent` discriminated union array:

```ts
export const AgentEvent = z.discriminatedUnion('kind', [
  StreamChunk,
  ToolStart,
  ToolEnd,
  Done,
  FatalError,
  Usage,
  AssistantIter,
  ApprovalRequested,
  TodoUpdated,           // <-- new
  CompactStarted,
  CompactCompleted,
  CompactFailed,
])
```

- [ ] **Step 4: Add wire `TodoUpdated` to `browser/rpc/protocol.ts`**

Locate the existing wire `AgentEvent` discriminated union. Before its declaration, add:

```ts
const TodoUpdated = Base.extend({
  kind: z.literal('todo/updated'),
  conversationId: Uuid,
  items: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed']),
      description: z.string().optional(),
      activeForm: z.string().optional(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
    }),
  ),
})
```

Add to wire `AgentEvent` array (alongside `MessageUsage`, `ApprovalRequested`, etc.):

```ts
export const AgentEvent = z.discriminatedUnion('kind', [
  // ...existing wire schemas
  TodoUpdated,
])
```

(The exact existing list will be visible when reading the file; append `TodoUpdated` to it.)

- [ ] **Step 5: Run tests to confirm pass**

```bash
cd packages/agent-kernel && bun run test tests/core/protocol.test.ts
```
Expected: all PASS (existing + 5 new).

- [ ] **Step 6: Full kernel test + typecheck**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
```
Expected: 291 + 5 = 296 tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-kernel/src/core/protocol.ts \
        packages/agent-kernel/src/browser/rpc/protocol.ts \
        packages/agent-kernel/tests/core/protocol.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): AgentEvent gains todo/updated (core + wire)

Additive Zod schemas. Core variant has flat shape (no envelope); wire
variant extends Base with id/sessionId/ts. Both carry the full TodoItem[]
+ conversationId so consumers can replace their UI state in one shot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `createIdbTodoStore` + DB migration

**Files:**
- Modify: `packages/agent-kernel/src/browser/storage/db.ts`(DB_VERSION 1→2;upgrade adds `todos` store;`MycliWebSchema` gains `todos` field)
- Create: `packages/agent-kernel/src/browser/storage/createIdbTodoStore.ts`
- Modify: `packages/agent-kernel/src/index.ts`(导出 `createIdbTodoStore`)
- Create: `packages/agent-kernel/tests/browser/storage/createIdbTodoStore.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-kernel/tests/browser/storage/createIdbTodoStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createIdbTodoStore } from 'agent-kernel'
import { openDb, resetDbForTests } from 'agent-kernel'

beforeEach(async () => {
  await resetDbForTests()
})

describe('createIdbTodoStore', () => {
  it('list returns empty array for a conversation with no todos', async () => {
    const store = await createIdbTodoStore(await openDb())
    const items = await store.list('c1')
    expect(items).toEqual([])
  })

  it('replace inserts new items with generated ids and timestamps', async () => {
    const store = await createIdbTodoStore(await openDb())
    const before = Date.now()
    const result = await store.replace('c1', [
      { subject: 'A', status: 'pending' },
      { subject: 'B', status: 'in_progress', activeForm: 'Doing B' },
    ])
    const after = Date.now()
    expect(result).toHaveLength(2)
    expect(result[0].id).toBeTypeOf('string')
    expect(result[0].id.length).toBeGreaterThan(0)
    expect(result[0].id).not.toBe(result[1].id)
    expect(result[0].subject).toBe('A')
    expect(result[0].status).toBe('pending')
    expect(result[1].activeForm).toBe('Doing B')
    expect(result[0].createdAt).toBeGreaterThanOrEqual(before)
    expect(result[0].createdAt).toBeLessThanOrEqual(after)
    expect(result[0].updatedAt).toBe(result[0].createdAt)
  })

  it('replace preserves id + createdAt when input has an id', async () => {
    const store = await createIdbTodoStore(await openDb())
    const first = await store.replace('c1', [{ subject: 'A', status: 'pending' }])
    const originalId = first[0].id
    const originalCreatedAt = first[0].createdAt
    // Force time advance
    await new Promise((r) => setTimeout(r, 5))
    const second = await store.replace('c1', [
      { id: originalId, subject: 'A revised', status: 'in_progress' },
    ])
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(originalId)
    expect(second[0].createdAt).toBe(originalCreatedAt)
    expect(second[0].updatedAt).toBeGreaterThan(originalCreatedAt)
    expect(second[0].subject).toBe('A revised')
    expect(second[0].status).toBe('in_progress')
  })

  it('replace removes items absent from new input', async () => {
    const store = await createIdbTodoStore(await openDb())
    const first = await store.replace('c1', [
      { subject: 'A', status: 'pending' },
      { subject: 'B', status: 'pending' },
    ])
    const second = await store.replace('c1', [
      { id: first[0].id, subject: 'A', status: 'completed' },
    ])
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(first[0].id)
    // B is gone
    const listed = await store.list('c1')
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(first[0].id)
  })

  it('replace with empty array clears the list', async () => {
    const store = await createIdbTodoStore(await openDb())
    await store.replace('c1', [{ subject: 'A', status: 'pending' }])
    const cleared = await store.replace('c1', [])
    expect(cleared).toEqual([])
    expect(await store.list('c1')).toEqual([])
  })

  it('list is isolated by conversationId', async () => {
    const store = await createIdbTodoStore(await openDb())
    await store.replace('c1', [{ subject: 'A', status: 'pending' }])
    await store.replace('c2', [{ subject: 'B', status: 'pending' }])
    const c1Items = await store.list('c1')
    const c2Items = await store.list('c2')
    expect(c1Items).toHaveLength(1)
    expect(c2Items).toHaveLength(1)
    expect(c1Items[0].subject).toBe('A')
    expect(c2Items[0].subject).toBe('B')
  })
})
```

- [ ] **Step 2: Run tests to confirm fail**

```bash
cd packages/agent-kernel && bun run test tests/browser/storage/createIdbTodoStore.test.ts
```
Expected: FAIL — `createIdbTodoStore` not exported / `'todos'` store not in DB schema.

- [ ] **Step 3: Update `db.ts` — bump version + add `todos` store**

In `packages/agent-kernel/src/browser/storage/db.ts`:

Find `export const DB_VERSION = 1` and change to:

```ts
export const DB_VERSION = 2
```

Find `MycliWebSchema` interface (~line 69). Inside the schema, add (alongside the existing object stores like `conversations`, `messages`, `skills`, `skillData`, `auditLog`):

```ts
  todos: {
    key: string  // conversationId
    value: {
      conversationId: string
      items: TodoItem[]
    }
  }
```

You'll need to import `TodoItem`:

```ts
import type { TodoItem } from '../../adapters/TodoStoreAdapter'
```

Find the `openDB<MycliWebSchema>(DB_NAME, DB_VERSION, { upgrade(db, oldVersion) { ... } })` block. Extend the upgrade callback:

```ts
upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    // ...existing v1 schema (conversations, messages, skills, skillData, auditLog)
  }
  if (oldVersion < 2) {
    db.createObjectStore('todos', { keyPath: 'conversationId' })
  }
},
```

(The exact existing structure of the upgrade callback dictates how `oldVersion < 2` is added — match the pattern. If the existing upgrade isn't already version-gated like this, add a version gate around the existing v1 ops to preserve idempotency.)

- [ ] **Step 4: Create `createIdbTodoStore.ts`**

```ts
// packages/agent-kernel/src/browser/storage/createIdbTodoStore.ts
import type { IDBPDatabase } from 'idb'
import type { MycliWebSchema } from './db'
import type {
  TodoItem,
  TodoStoreAdapter,
  TodoWriteInput,
} from '../../adapters/TodoStoreAdapter'

export async function createIdbTodoStore(
  db: IDBPDatabase<MycliWebSchema>,
): Promise<TodoStoreAdapter> {
  return {
    async list(conversationId) {
      const row = await db.get('todos', conversationId)
      return row?.items ?? []
    },

    async replace(conversationId, items: TodoWriteInput[]) {
      const tx = db.transaction('todos', 'readwrite')
      const existing = (await tx.store.get(conversationId))?.items ?? []
      const byId = new Map<string, TodoItem>(existing.map((i) => [i.id, i]))
      const now = Date.now()
      const next: TodoItem[] = items.map((input) => {
        const prev = input.id ? byId.get(input.id) : undefined
        return {
          id: prev?.id ?? input.id ?? crypto.randomUUID(),
          subject: input.subject,
          status: input.status,
          description: input.description,
          activeForm: input.activeForm,
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        }
      })
      if (next.length === 0) {
        await tx.store.delete(conversationId)
      } else {
        await tx.store.put({ conversationId, items: next })
      }
      await tx.done
      return next
    },
  }
}
```

- [ ] **Step 5: Export from `index.ts`**

Find the existing `browser storage` exports in `packages/agent-kernel/src/index.ts` (alongside `createIdbMessageStore`). Add:

```ts
export { createIdbTodoStore } from './browser/storage/createIdbTodoStore'
```

- [ ] **Step 6: Run tests to confirm pass**

```bash
cd packages/agent-kernel && bun run test tests/browser/storage/createIdbTodoStore.test.ts
```
Expected: 6 cases PASS. If a test environment's `fake-indexeddb` mock complains about the version migration, the `tests/setup.ts` already wipes the DB per-test — confirm `resetDbForTests()` is called in `beforeEach`.

- [ ] **Step 7: Full kernel test + typecheck**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
```
Expected: 296 + 6 = 302 tests green. Pre-existing `db.test.ts` may show the new `todos` store in its assertions — if it asserts a specific store list, update that test to include `'todos'`.

If `db.test.ts` fails, inspect:
```bash
cd packages/agent-kernel && bun run test tests/browser/storage/db.test.ts
```
And update the assertion to match the new store inventory.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-kernel/src/browser/storage/db.ts \
        packages/agent-kernel/src/browser/storage/createIdbTodoStore.ts \
        packages/agent-kernel/src/index.ts \
        packages/agent-kernel/tests/browser/storage/createIdbTodoStore.test.ts \
        packages/agent-kernel/tests/browser/storage/db.test.ts  # only if updated
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): createIdbTodoStore + DB v2 migration

Default IDB implementation of TodoStoreAdapter. New 'todos' object store
keyed by conversationId, value is { conversationId, items: TodoItem[] }
— one row per conversation holding the full list. replace() preserves
existing id+createdAt for items whose id is provided, generates fresh
uuid+createdAt for new items, bumps updatedAt unconditionally, and
deletes the row entirely when the new list is empty.

DB_VERSION bumped 1 → 2 with idempotent upgrade callback gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: agentService integration

**Files:**
- Modify: `packages/agent-kernel/src/browser/agentService.ts`(deps field;ctx injection;tool/end emit;loadConversation 初始 emit)
- Modify: `packages/agent-kernel/tests/browser/agentService.test.ts`(扩)

- [ ] **Step 1: Inspect existing agentService patterns**

```bash
grep -n "kind === 'tool/end'\|kind: 'tool/end'\|chat/loadConversation\|approvalAdapter\|toolContext:" packages/agent-kernel/src/browser/agentService.ts | head -20
grep -n "makeDeps\|approvalAdapter\|approvalCoordinator\|agentEvents:" packages/agent-kernel/tests/browser/agentService.test.ts | head -20
```

Confirm:
- Where `tool/end` events are emitted to the wire (or where they're inspected for side-effects)
- Where the `chat/loadConversation` ClientCmd is handled
- How `makeDeps` test helper extends — it already accepts `approvalAdapter`, `approvalCoordinator`. Add `todoStore` the same way.

- [ ] **Step 2: Write failing tests**

Append to `packages/agent-kernel/tests/browser/agentService.test.ts`:

```ts
import { type TodoStoreAdapter, type TodoItem } from 'agent-kernel'

const stubTodoStore = (overrides: Partial<TodoStoreAdapter> = {}): TodoStoreAdapter => ({
  list: vi.fn().mockResolvedValue([]),
  replace: vi.fn().mockResolvedValue([]),
  ...overrides,
})

describe('agentService todo flow', () => {
  it('emits wire todo/updated after a successful todoWrite tool call', async () => {
    const canonical: TodoItem[] = [
      { id: 't1', subject: 'A', status: 'pending', createdAt: 1, updatedAt: 1 },
    ]
    const todoStore = stubTodoStore({
      replace: vi.fn().mockResolvedValue(canonical),
    })
    const { deps, events } = makeDeps({
      todoStore,
      agentEvents: [
        {
          kind: 'tool/start',
          toolCall: { id: 'tc1', tool: 'todoWrite', args: { items: [{ subject: 'A', status: 'pending' }] } },
        },
        {
          kind: 'tool/end',
          toolCallId: 'tc1',
          result: {
            ok: true,
            content: JSON.stringify({ count: 1, items: canonical }),
          },
        },
        { kind: 'done', stopReason: 'end_turn', assistantText: '' },
      ],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'do it' })
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeDefined()
    expect(todoEvt.conversationId).toBeDefined()
    expect(todoEvt.items).toEqual(canonical)
  })

  it('does NOT emit todo/updated for non-todoWrite tools', async () => {
    const todoStore = stubTodoStore()
    const { deps, events } = makeDeps({
      todoStore,
      agentEvents: [
        {
          kind: 'tool/start',
          toolCall: { id: 'tc1', tool: 'readPage', args: {} },
        },
        {
          kind: 'tool/end',
          toolCallId: 'tc1',
          result: { ok: true, content: 'page content' },
        },
        { kind: 'done', stopReason: 'end_turn', assistantText: '' },
      ],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'read' })
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeUndefined()
  })

  it('does NOT emit todo/updated when todoWrite tool returns ok: false', async () => {
    const todoStore = stubTodoStore()
    const { deps, events } = makeDeps({
      todoStore,
      agentEvents: [
        {
          kind: 'tool/start',
          toolCall: { id: 'tc1', tool: 'todoWrite', args: { items: [] } },
        },
        {
          kind: 'tool/end',
          toolCallId: 'tc1',
          result: { ok: false, content: '{"code":"todo_persist_failed","message":"idb boom"}' },
        },
        { kind: 'done', stopReason: 'end_turn', assistantText: '' },
      ],
    })
    const svc = createAgentService(deps as any)
    await svc.runTurn({ sessionId: 's1', text: 'do it' })
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeUndefined()
  })

  it('emits initial todo/updated when a conversation is loaded', async () => {
    const initial: TodoItem[] = [
      { id: 't1', subject: 'X', status: 'pending', createdAt: 1, updatedAt: 1 },
    ]
    const todoStore = stubTodoStore({
      list: vi.fn().mockResolvedValue(initial),
    })
    const { deps, events } = makeDeps({
      todoStore,
    })
    const svc = createAgentService(deps as any)
    await svc.handleCommand?.({
      id: crypto.randomUUID(),
      sessionId: 's1',
      ts: Date.now(),
      kind: 'chat/loadConversation',
      conversationId: 'cv1',
    } as any)
    const todoEvt = events.find((e) => e.kind === 'todo/updated')
    expect(todoEvt).toBeDefined()
    expect(todoEvt.items).toEqual(initial)
  })
})
```

**Note**: the `tool/end` mock format the existing `makeDeps` produces may not match the test's hand-crafted shape — the agentService might intercept the tool result through `result.data` not `JSON.parse(result.content)`. The implementer should INSPECT how the existing `agentService.ts` parses tool results in tool/end events. If the data is passed structured (not stringified), update the test to pass `result.data: { count: 1, items: canonical }` instead.

- [ ] **Step 3: Run tests to confirm fail**

```bash
cd packages/agent-kernel && bun run test tests/browser/agentService.test.ts
```
Expected: 4 new cases FAIL — `deps.todoStore` not in interface;`todo/updated` events not emitted;`chat/loadConversation` doesn't trigger initial emit.

- [ ] **Step 4: Extend `AgentServiceDeps` interface**

In `packages/agent-kernel/src/browser/agentService.ts`, find the `AgentServiceDeps` interface. Add:

```ts
import type { TodoStoreAdapter } from '../adapters/TodoStoreAdapter'
import type { TodoItem } from '../adapters/TodoStoreAdapter'
```

```ts
export interface AgentServiceDeps {
  // ...existing fields
  /** Per-conversation todo store. Required for todoWriteTool to function. */
  todoStore?: TodoStoreAdapter
}
```

- [ ] **Step 5: Update `makeDeps` test helper**

In the test file, the existing `makeDeps` function accepts `approvalCoordinator`, `approvalAdapter` etc. Extend it to accept `todoStore`:

```ts
function makeDeps(overrides: {
  // ...existing options
  todoStore?: TodoStoreAdapter
  // ...
} = {}) {
  // ...existing implementation
  return {
    deps: {
      // ...existing fields
      todoStore: overrides.todoStore,
    },
    // ...
  }
}
```

(Read the existing makeDeps to know its exact shape; add `todoStore` alongside the existing optional-pass-through fields like approvalAdapter.)

- [ ] **Step 6: Inject ctx + emit on tool/end**

In `createAgentService.runTurn`, find where `ToolExecContext` is constructed (look for `toolContext` or `ctx:` near the agent invocation). Add `todoStore` and `conversationId`:

```ts
const ctx = {
  ...deps.toolContext({ sessionId: cmd.sessionId, conversationId: cid }),
  signal,
  todoStore: deps.todoStore,
  conversationId: cid,
}
```

(The exact existing shape varies — adapt. The two new fields go into whatever object becomes the `ToolExecContext` per turn.)

Find where `tool/end` events are processed (where the loop yields `{ kind: 'tool/end', ... }` events to `deps.emit`). After emitting the standard `tool/end` wire event, add:

```ts
if (ev.toolCall && ev.toolCall.tool === 'todoWrite' && ev.result?.ok) {
  // result.data has shape { count, items } per todoWriteTool's contract
  const items = (ev.result.data as { items?: TodoItem[] })?.items ?? []
  deps.emit({
    id: crypto.randomUUID(),
    sessionId: cmd.sessionId,
    ts: Date.now(),
    kind: 'todo/updated',
    conversationId: cid!,
    items,
  })
}
```

(Place this in the same handler block as `tool/end` translation. Exact event shape and field names depend on how agentService maps internal `tool/end` events to wire — read it and match.)

- [ ] **Step 7: Emit initial todo/updated on `chat/loadConversation`**

In `handleCommand` (or wherever `chat/loadConversation` is dispatched), at the very end of the handler (AFTER any existing emit like `state/snapshot`), add:

```ts
if (deps.todoStore) {
  const items = await deps.todoStore.list(cmd.conversationId)
  deps.emit({
    id: crypto.randomUUID(),
    sessionId: cmd.sessionId,
    ts: Date.now(),
    kind: 'todo/updated',
    conversationId: cmd.conversationId,
    items,
  })
}
```

- [ ] **Step 8: Run tests to confirm pass**

```bash
cd packages/agent-kernel && bun run test tests/browser/agentService.test.ts
```
Expected: 4 new cases PASS + all existing agentService tests still PASS.

If the wire shape assertions in the new tests fail because the actual emitted event differs from the test's expected shape, adjust the TEST to match what the implementation produces (within reason — the kernel emission shape should match `tests/core/protocol.test.ts`'s wire schema).

- [ ] **Step 9: Full kernel test + typecheck + consumer build**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
cd ../mycli-web && bun run test
cd ../mycli-web && bun run build
```
Expected: typecheck clean. Kernel 302 + 4 = 306 tests. Consumer 47 unchanged. Build OK.

- [ ] **Step 10: Commit**

```bash
git add packages/agent-kernel/src/browser/agentService.ts \
        packages/agent-kernel/tests/browser/agentService.test.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): agentService wires todoStore + emits todo/updated

AgentServiceDeps accepts an optional todoStore. The per-turn
ToolExecContext now carries todoStore + conversationId so todoWriteTool
can persist. After a successful tool/end with name='todoWrite', the
service emits a wire todo/updated event with the canonical items list.
On chat/loadConversation, the current list is emitted so the UI syncs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: bootKernelOffscreen options + auto-register `todoWriteTool`

**Files:**
- Modify: `packages/agent-kernel/src/browser/bootKernelOffscreen.ts`(option;default IDB;auto tool registration)

- [ ] **Step 1: Inspect existing bootKernelOffscreen**

```bash
grep -n "BootKernelOffscreenOptions\|createAgentService\|approvalAdapter\|tools:" packages/agent-kernel/src/browser/bootKernelOffscreen.ts | head -20
```

Note how `approvalAdapter` was wired in #2 — match that pattern for `todoStore`.

- [ ] **Step 2: Write failing typecheck signal (no full test)**

bootKernelOffscreen has no dedicated test file with module-spy infrastructure (per #2 T5 fix review). The new option's correctness is verified by:
1. typecheck — confirms the field exists on options + is forwarded
2. Downstream T6 UI test exercising the full chain

Skip writing a unit test for bootKernelOffscreen forwarding. Confirm by inspection + typecheck.

- [ ] **Step 3: Add option + default IDB + auto tool registration**

In `packages/agent-kernel/src/browser/bootKernelOffscreen.ts`:

Add imports:

```ts
import { createIdbTodoStore } from './storage/createIdbTodoStore'
import { todoWriteTool } from '../core/tools/todoWrite'
import type { TodoStoreAdapter } from '../adapters/TodoStoreAdapter'
```

Find `BootKernelOffscreenOptions` interface. Add:

```ts
export interface BootKernelOffscreenOptions {
  // ...existing fields (tools, approvalAdapter, buildApprovalContext, etc.)
  /** Per-conversation todo store. Defaults to createIdbTodoStore using the
   *  kernel's IDB. Pass null to disable todo support entirely. */
  todoStore?: TodoStoreAdapter | null
}
```

Find where `createAgentService` is called inside `bootKernelOffscreen`. Above the call, resolve the todoStore:

```ts
const todoStore =
  opts.todoStore === null
    ? undefined  // explicitly disabled
    : opts.todoStore ?? (await createIdbTodoStore(db))
```

(`db` should be the existing IDBPDatabase opened earlier in the function; locate via `await openDb()` or similar.)

Pass through to `createAgentService`:

```ts
const agentService = createAgentService({
  // ...existing fields
  todoStore,
  tools: [...(opts.tools ?? []), todoWriteTool],
})
```

**Important**: `tools: [...(opts.tools ?? []), todoWriteTool]` — auto-register the kernel-shipped tool so consumers don't have to. If the existing line already spreads `opts.tools`, just append `todoWriteTool` at the end.

- [ ] **Step 4: Verify typecheck + full test**

```bash
bun run typecheck
cd packages/agent-kernel && bun run test
cd ../mycli-web && bun run test
cd ../mycli-web && bun run build
```
Expected: typecheck clean. All 306 kernel + 47 consumer tests still green. Build OK.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-kernel/src/browser/bootKernelOffscreen.ts
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(kernel): bootKernelOffscreen ships todoStore + todoWriteTool by default

Adds todoStore? option to BootKernelOffscreenOptions:
- undefined → kernel constructs createIdbTodoStore using its IDB (default)
- explicit instance → use that (custom adapter)
- null → explicitly disable todo support

todoWriteTool is auto-appended to the agent's tool list so any consumer
that calls bootKernelOffscreen gets TodoWrite for free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Consumer `TodoList` UI + ChatApp integration

**Files:**
- Create: `packages/mycli-web/src/extension/ui/TodoList.tsx`
- Modify: `packages/mycli-web/src/extension/content/ChatApp.tsx`(state + subscription + mount)
- Create: `packages/mycli-web/tests/extension/ui/TodoList.test.tsx`

- [ ] **Step 1: Discover the existing ChatApp shape**

```bash
grep -n "client.on\|setMessages\|setPendingApproval\|ChatWindow" packages/mycli-web/src/extension/content/ChatApp.tsx | head -20
```

You should see a pattern for subscribing to wire events and storing in state (e.g. `client.on('approval/requested', ...)`). Match that for `todo/updated`.

- [ ] **Step 2: Write failing tests for `TodoList`**

```tsx
// packages/mycli-web/tests/extension/ui/TodoList.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TodoList } from '@ext/ui/TodoList'
import type { TodoItem } from 'agent-kernel'

const item = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: overrides.id ?? 't1',
  subject: overrides.subject ?? 'Sample',
  status: overrides.status ?? 'pending',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe('TodoList', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(<TodoList items={[]} />)
    expect(container.querySelector('[data-testid="todo-list"]')).toBeNull()
  })

  it('renders each item with its subject', () => {
    render(
      <TodoList
        items={[
          item({ id: 't1', subject: 'First task' }),
          item({ id: 't2', subject: 'Second task' }),
        ]}
      />,
    )
    expect(screen.getByText('First task')).toBeTruthy()
    expect(screen.getByText('Second task')).toBeTruthy()
  })

  it('shows activeForm for in_progress items, subject otherwise', () => {
    render(
      <TodoList
        items={[
          item({ id: 't1', subject: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' }),
          item({ id: 't2', subject: 'Refactor', activeForm: 'Refactoring', status: 'pending' }),
        ]}
      />,
    )
    expect(screen.getByText('Writing tests')).toBeTruthy()
    expect(screen.getByText('Refactor')).toBeTruthy()
    expect(screen.queryByText('Refactoring')).toBeNull()
  })

  it('renders status indicators for each status', () => {
    const { container } = render(
      <TodoList
        items={[
          item({ id: 't1', subject: 'A', status: 'pending' }),
          item({ id: 't2', subject: 'B', status: 'in_progress' }),
          item({ id: 't3', subject: 'C', status: 'completed' }),
        ]}
      />,
    )
    // Each item has a data-status attribute for CSS / a11y
    expect(container.querySelector('[data-status="pending"]')).toBeTruthy()
    expect(container.querySelector('[data-status="in_progress"]')).toBeTruthy()
    expect(container.querySelector('[data-status="completed"]')).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run tests to confirm fail**

```bash
cd packages/mycli-web && bun run test tests/extension/ui/TodoList.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 4: Create `TodoList.tsx`**

```tsx
// packages/mycli-web/src/extension/ui/TodoList.tsx
import type { TodoItem } from 'agent-kernel'

export interface TodoListProps {
  items: TodoItem[]
}

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  pending: '☐',
  in_progress: '▶',
  completed: '✓',
}

export function TodoList({ items }: TodoListProps) {
  if (items.length === 0) return null
  return (
    <div
      data-testid="todo-list"
      style={{
        padding: 8,
        borderRadius: 6,
        background: 'rgba(0,0,0,0.04)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Todo</div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {items.map((item) => (
          <li
            key={item.id}
            data-status={item.status}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              padding: '2px 0',
              opacity: item.status === 'completed' ? 0.5 : 1,
              textDecoration: item.status === 'completed' ? 'line-through' : 'none',
            }}
          >
            <span aria-hidden="true">{STATUS_GLYPH[item.status]}</span>
            <span>
              {item.status === 'in_progress' && item.activeForm
                ? item.activeForm
                : item.subject}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
cd packages/mycli-web && bun run test tests/extension/ui/TodoList.test.tsx
```
Expected: 4 cases PASS.

- [ ] **Step 6: Integrate into ChatApp.tsx**

In `packages/mycli-web/src/extension/content/ChatApp.tsx`:

Add import:

```tsx
import { TodoList } from '../ui/TodoList'
import type { TodoItem } from 'agent-kernel'
```

Add state alongside the existing `pendingApproval` state:

```tsx
const [todos, setTodos] = useState<TodoItem[]>([])
```

Add subscription in the same `useEffect` block that already calls `client.on(...)` for other events:

```tsx
const unsubTodo = client.on('todo/updated', (ev: any) => {
  setTodos(ev.items ?? [])
})
// ...
return () => {
  // ...existing unsubscribes
  unsubTodo()
}
```

(Match the exact `client.on` API used by existing subscriptions in the file. If they pattern is `client.on(kind, handler)` returning an unsubscribe function, use that.)

In the returned JSX, mount `<TodoList items={todos} />` somewhere visible — adjacent to ChatWindow, or above it inside the chat panel. The implementer reads the current JSX and picks a sensible spot. The component returns null when empty, so it's safe to always include.

Also clear todos in `resetTurnState()` (or whatever clears per-conversation UI state) — but only if `resetTurnState` is called on `newConversation` / `selectConversation`. If it is, todos will be re-emitted by the kernel via the initial `todo/updated` on `chat/loadConversation`, so clearing locally first prevents stale display while the kernel responds. Add to the existing reset code:

```tsx
setTodos([])
```

- [ ] **Step 7: Run consumer tests + typecheck**

```bash
bun run typecheck
cd packages/mycli-web && bun run test
cd packages/mycli-web && bun run build
```
Expected: typecheck clean. Consumer 47 + 4 = 51 tests green. Build OK.

- [ ] **Step 8: Commit**

```bash
git add packages/mycli-web/src/extension/ui/TodoList.tsx \
        packages/mycli-web/tests/extension/ui/TodoList.test.tsx \
        packages/mycli-web/src/extension/content/ChatApp.tsx
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "feat(consumer): TodoList UI + ChatApp subscription

Read-only React component renders the LLM-owned todo list. Subscribes
to wire 'todo/updated' events in ChatApp, replaces state on every event.
in_progress items show activeForm; completed items are dimmed +
strikethrough. Component returns null when empty, so it's always safe
to mount.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full-stack verification + portability grep + handoff

**Files:**
- Create: `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-todowrite.md`

- [ ] **Step 1: Full repo verification**

From worktree root:
```bash
bun run typecheck
cd packages/agent-kernel && bun run test
cd ../mycli-web && bun run test
cd ../mycli-web && bun run build
```

Record numbers. Expected:
- kernel: ~306 tests (baseline 286 + ~20 from this sub-project)
- consumer: ~51 tests (baseline 47 + 4 from TodoList)

- [ ] **Step 2: Portability grep guards**

Verify `packages/agent-kernel/src/core/` has zero chrome / DOM / mycli-web imports:

```bash
grep -rn "chrome\.\|from 'chrome'\|document\.\|window\.\|@ext/" packages/agent-kernel/src/core/ --include="*.ts" | grep -v '\.test\.' || echo "core is clean"
```

Expected: `core is clean`.

Verify `packages/agent-kernel/src/browser/` has zero mycli-web imports:

```bash
grep -rn "@ext/\|from 'mycli-web\|packages/mycli-web" packages/agent-kernel/src/browser/ --include="*.ts" | grep -v '\.test\.' || echo "browser is mycli-clean"
```

Expected: `browser is mycli-clean`.

If either fails, FLAG it — fix before continuing.

- [ ] **Step 3: Write handoff**

Get commits:
```bash
git log --oneline 4d14659..HEAD
```

(`4d14659` is the spec commit — replace with actual SHA of the docs commit immediately before T1.)

Create `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-todowrite.md`. Match the style of existing handoffs at `packages/mycli-web/docs/superpowers/HANDOFF-2026-05-12-*.md`. Sections (Chinese prose):

1. **一句话总结** — TodoWrite end-to-end done, test counts, build clean
2. **跑了什么** — 7 tasks via subagent-driven flow, commit SHAs in a table
3. **如何试一下** — option A (kernel unit tests + live agent): mention the specific test files; option B (load extension and prompt the LLM with "make a todo list for X"): a brief recipe
4. **改了哪些文件** — kernel core/ + adapters/ + browser/ + consumer files (4 sub-sections)
5. **跨浏览器扩展可迁移性** — any MV3 extension passes a TodoStoreAdapter (or uses the kernel-default IDB) and consumes 'todo/updated' wire events. Reference the grep guards.
6. **已知问题** — `todoWriteTool` not yet "advertised" to LLM via any system-prompt instruction (LLM has to know to use it; the tool's description is the only signal); no user editing (single-direction flow); no integration test exercising the full LLM→todoWrite→UI chain (covered piecewise)
7. **下一步** — sub-projects #4 (Sub-agent / Fork) and #5 (Multi-tab orchestration) remain. Plan mode is a separate future spec (referenced in this spec's §不在范围).

- [ ] **Step 4: Commit handoff**

```bash
git add packages/mycli-web/docs/superpowers/HANDOFF-2026-05-13-todowrite.md
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "docs: handoff for TodoWrite

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Final sanity check**

```bash
git log --oneline 4d14659..HEAD
```

Expected: ~8 commits (7 task commits + 1 handoff). Working tree clean.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Types (TodoStatus, TodoItem, TodoWriteInput) | T1 |
| TodoStoreAdapter interface | T1 |
| todoWriteTool | T1 |
| core AgentEvent TodoUpdated Zod | T2 |
| wire AgentEvent TodoUpdated Zod | T2 |
| createIdbTodoStore + DB migration | T3 |
| agentService ctx injection + emit + loadConversation initial emit | T4 |
| bootKernelOffscreen options + default + auto-register tool | T5 |
| Consumer TodoList UI + ChatApp integration | T6 |
| Portability grep guards | T7 |
| Handoff doc | T7 |

All spec sections have a task. No gaps.

**Placeholder scan:**
- T4 Step 2 contains a note "the implementer should INSPECT how the existing agentService.ts parses tool results in tool/end events" — this is a guided discovery, not a placeholder. The test code is concrete; the note explains why adaptation may be needed. Acceptable.
- T6 Step 6 says "match the exact `client.on` API used by existing subscriptions" — same pattern, guided discovery. Acceptable.
- T5 Step 3 says "If the existing line already spreads `opts.tools`, just append `todoWriteTool` at the end" — guidance, not placeholder.
- No "TBD" / "TODO" / "fill in details" present.

**Type consistency:**
- `TodoStatus = 'pending' | 'in_progress' | 'completed'` — consistent across T1 (types.ts), T2 (Zod enums), T6 (UI glyph map).
- `TodoItem { id, subject, status, description?, activeForm?, createdAt, updatedAt }` — same shape in adapter, Zod, UI props.
- `TodoWriteInput { id?, subject, status, description?, activeForm? }` — consistent.
- `TodoStoreAdapter { list, replace }` — consistent across T1, T3, T4, T5.
- `todoWriteTool.name = 'todoWrite'` — consistent.
- Wire event kind `'todo/updated'` + field `conversationId` + field `items` — consistent across T2, T4, T6.

No dangling references. Plan locked.
