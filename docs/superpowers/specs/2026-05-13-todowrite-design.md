# TodoWrite 设计

状态:spec,待实施
日期:2026-05-13

## 概述

让 agent 在执行多步任务时维护一个 todo 列表。LLM 通过 kernel 出的 `todoWrite` 工具全量提交新列表;todo 按 conversation 持久化到 IndexedDB;wire 协议 emit `todo/updated` 事件,consumer 自由渲染。

按 kernel-first 原则:`TodoStoreAdapter` 接口 + 默认 IDB 实现都在 kernel,任何浏览器扩展只要复用默认或提供自己的 adapter 即可获得 TodoWrite 能力。Plan mode 是后续的独立 sub-project,本 spec 不涉及。

## 目标

- LLM 通过单个 `todoWrite({ items: [...] })` 工具全量替换 todo 列表
- 每个 conversation 一份独立的 todo 列表,跨页面 reload 保留(IDB)
- 切换 conversation,UI 看到对应列表(由 agentService 在 loadConversation 时 emit 初始 `todo/updated`)
- Wire `todo/updated` 事件包含整个新列表 + conversationId,consumer 直接 setState 替换
- Kernel core 零 chrome 依赖;`TodoStoreAdapter` 默认 IDB 实现在 `browser/` 子目录
- 公开 API 让其他 MV3 扩展提供自己的 adapter(chrome.storage / 内存 / 远程同步等)

## 不在范围(本次)

- **Plan mode**(EnterPlanMode + 用户审批 + 计划锁定 + 执行)— 单独 sub-project
- **多原子工具**(addTodo / updateTodo / deleteTodo)— 选定单工具全量替换
- **User 手动编辑**— 单向数据流,UI 只读。需双向交互可后续 spec
- **Checkpoint snapshot 消息**— 不在 MessageStore 里插 todo 快照
- **跨会话 todo / 全局 todo 工作区**— 严格 per-conversation
- **Ephemeral 会话支持**— 临时 turn(无 conversationId)调 todoWrite 返回错误
- **UI 渲染细节 / 样式 / 位置**— mycli-web 出一个最小 reference UI,样式与位置由 consumer 决定
- **Priority / tags / due dates**— YAGNI

## 架构

```
┌─ packages/agent-kernel/ ───────────────────────────────────────┐
│ core/(零 chrome 依赖)                                          │
│   types.ts(改)                                                 │
│     新增 TodoStatus / TodoItem / TodoWriteInput 类型            │
│     ToolExecContext 加 todoStore? + conversationId?             │
│   adapters/index.ts(改)                                        │
│     新增 TodoStoreAdapter 接口                                  │
│   tools/todoWrite.ts(新)                                       │
│     export const todoWriteTool: ToolDefinition                  │
│     execute 内 ctx.todoStore.replace(ctx.conversationId, items) │
│   protocol.ts(改)                                              │
│     core AgentEvent 加 TodoUpdated Zod                          │
│                                                                 │
│ browser/(可 chrome.*)                                          │
│   storage/createIdbTodoStore.ts(新,~80 LOC)                    │
│     创建 'todos' object store(key=conversationId,value=        │
│     TodoItem[]);返回 TodoStoreAdapter 实现                      │
│   storage/db.ts(改)                                            │
│     现有 DB schema 加 'todos' object store(数据库 version bump)│
│   rpc/protocol.ts(改)                                          │
│     wire AgentEvent 加 todo/updated Zod                         │
│   agentService.ts(改)                                          │
│     注入 todoStore + conversationId 到 ToolExecContext;         │
│     在 tool/end 处理后,name === 'todoWrite' && ok →             │
│       emit wire todo/updated(conversationId, items)             │
│     loadConversation handler 末尾 emit 初始 todo/updated        │
│   bootKernelOffscreen.ts(改)                                   │
│     options 加 todoStore?: TodoStoreAdapter(默认 IDB)           │
│                                                                 │
│ index.ts(改) 公开导出新 symbols                                │
└─────────────────────────────────────────────────────────────────┘
                          ▲ 被引用
                          │
┌─ packages/mycli-web/src/extension/(reference consumer)─────┐
│   ui/TodoList.tsx(新)                                           │
│     订阅 wire 'todo/updated' → setState → 渲染列表              │
│     状态映射:pending → ☐,in_progress → ▶,completed → ✓        │
│     activeForm 在 in_progress 时显示,否则 subject              │
│   content/ChatApp.tsx(改)                                       │
│     <TodoList /> 挂载;具体位置 implementer 决定                 │
│   offscreen.ts(改) 不需要改 — bootKernelOffscreen 默认 IDB     │
└─────────────────────────────────────────────────────────────────┘
```

**另一个浏览器插件想用 TodoWrite**:`bootKernelOffscreen({ todoStore: myCustomStore })`,或者直接用默认。kernel 自带 `todoWriteTool`,只要 ToolExecContext 注入了 todoStore + conversationId 就工作。零 fork。

## Kernel API 详细

### 1. `core/types.ts` 改

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface ToolExecContext {
  signal?: AbortSignal
  // existing fields...
  /** Per-conversation todo store. Injected by agentService for tools that need it. */
  todoStore?: TodoStoreAdapter
  /** Active conversation id. Undefined for ephemeral turns. */
  conversationId?: ConversationId
}
```

(`TodoItem` / `TodoWriteInput` / `TodoStoreAdapter` 全部放在 `adapters/index.ts`,与现有 `MessageRecord` / `AppendMessageInput` / `MessageStoreAdapter` 对齐。`TodoStatus` 放 types.ts 因为它是核心 enum;`TodoStoreAdapter` import 引用 `TodoStatus`。)

### 2. `adapters/index.ts` 新增

```ts
import type { TodoStatus, ConversationId } from '../core/types'

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
  list(conversationId: ConversationId): Promise<TodoItem[]>
  /**
   * Atomically replace the entire list. Items WITH id preserve original
   * createdAt; new items get fresh uuid + createdAt. updatedAt is bumped
   * on every replace for every item in the new list (no content-diff
   * heuristic — keep semantics simple). Items absent from input are removed.
   * Returns the canonical post-replace state.
   */
  replace(
    conversationId: ConversationId,
    items: TodoWriteInput[],
  ): Promise<TodoItem[]>
}
```

### 3. `core/tools/todoWrite.ts`(新)

```ts
import type { ToolDefinition } from '../types'
import type { TodoWriteInput, TodoItem } from '../../adapters'
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
    const result = await ctx.todoStore.replace(ctx.conversationId, items)
    return makeOk({ count: result.length, items: result })
  },
}
```

### 4. `core/protocol.ts` 改

加 `TodoUpdated` Zod schema:

```ts
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

加进 `AgentEvent` discriminated union。

### 5. `browser/storage/db.ts` 改

加 `todos` object store(IDB version bump):

```ts
// In MycliWebSchema type:
todos: { key: string; value: { conversationId: string; items: TodoItem[] } }

// In openDb upgrade callback:
if (oldVersion < N) {  // N = current version + 1
  db.createObjectStore('todos', { keyPath: 'conversationId' })
}
```

(N 由 implementer 看现有 DB_VERSION 决定;迁移路径加 1。)

### 6. `browser/storage/createIdbTodoStore.ts`(新)

实现 `TodoStoreAdapter`,用上面新加的 'todos' object store。`list` 读 `{ conversationId } => items[]`;`replace` 在单个事务内读旧列表 + 合并 id/createdAt + 写回。

### 7. `browser/rpc/protocol.ts` 改

wire `MessageUsage`-style addition:

```ts
const TodoUpdated = Base.extend({
  kind: z.literal('todo/updated'),
  conversationId: Uuid,
  items: z.array(/* same shape as core */),
})
```

加进 wire `AgentEvent` discriminated union。

### 8. `browser/agentService.ts` 改

- 在 `runTurn` 里构造 `ToolExecContext` 时塞 `todoStore: deps.todoStore` 和 `conversationId: cmd.conversationId`(后者可能已经存在)
- 在 tool 执行循环里,如果 `result.ok === true && call.name === 'todoWrite'`:
  ```ts
  deps.emit({
    id: crypto.randomUUID(),
    sessionId: cmd.sessionId,
    ts: Date.now(),
    kind: 'todo/updated',
    conversationId: cmd.conversationId,
    items: (result.data as { items: TodoItem[] }).items,
  })
  ```
- `AgentServiceDeps` 加 `todoStore?: TodoStoreAdapter` 字段
- `chat/loadConversation` handler 末尾:`const todos = await deps.todoStore.list(conversationId); deps.emit({ kind: 'todo/updated', ..., items: todos })`(初始同步)

### 9. `browser/bootKernelOffscreen.ts` 改

`BootKernelOffscreenOptions` 加 `todoStore?: TodoStoreAdapter`。装配 `createAgentService` 时:

```ts
const todoStore = opts.todoStore ?? createIdbTodoStore(db)
createAgentService({ ...existing, todoStore })
```

默认随手用 IDB 实现。装配时把 `todoWriteTool` 加进 agentService 默认 tools 列表(`agentService.tools = [...existing, todoWriteTool]`)— 这样任何 consumer 不显式禁用都能用 todoWrite。

### 10. `index.ts` 改

导出:
```ts
// In the existing "core 类型" export block:
export type { TodoStatus } from './core/types'

// In the existing "adapters" export block:
export type {
  TodoItem,
  TodoWriteInput,
  TodoStoreAdapter,
} from './adapters'

// New tools / storage exports alongside fetchGetTool / createIdbMessageStore:
export { todoWriteTool } from './core/tools/todoWrite'
export { createIdbTodoStore } from './browser/storage/createIdbTodoStore'
```

## 数据流

```
LLM 决定写 todo
    │
    ▼
LLM 调 todoWrite({ items: [{subject, status, ...}, ...] })
    │
    ▼
todoWriteTool.execute(input, ctx)
    │  ctx.todoStore + ctx.conversationId 由 agentService 注入
    │
    ├─→ ctx.todoStore.replace(conversationId, items)
    │      │  IDB 事务:读旧列表 → 合并 id/createdAt → 写新列表
    │      ▼
    │   返回 canonical TodoItem[]
    │
    ├─→ Tool 返回 { ok: true, data: { count: N, items: [...] } } 给 LLM
    │   (LLM 看到 count 和列表,可以在后续 turn 再调 todoWrite 更新)
    │
    └─→ agentService 检测到 tool.name === 'todoWrite' && ok:
        emit wire { kind: 'todo/updated', sessionId, conversationId, items }
            │
            ▼
        ChatApp client.on('todo/updated', e => setTodos(e.items))
            │
            ▼
        <TodoList items={todos} /> 渲染
```

切 conversation 时:
```
user clicks conversation X
    │
    ▼
client.send({ kind: 'chat/loadConversation', conversationId: X })
    │
    ▼
agentService.handleCommand:
    - emit state/snapshot(messages)
    - await todoStore.list(X) → emit todo/updated(items)
            │
            ▼
ChatApp setTodos(items)  // 同步过来
```

切回旧 conversation 或新建空 conversation:列表自动空(IDB 没数据)。

## 错误处理

- `todoStore.replace` IDB 失败 → tool 返回 `makeError('todo_persist_failed', err.message)`,LLM 看到再决定重试还是放弃。Wire 事件 NOT emitted。
- `ctx.conversationId` 缺失(ephemeral turn)→ tool 返回 `makeError('no_conversation', ...)`,LLM 应该理解并改用别的方式跟踪进度。
- `ctx.todoStore` 缺失(consumer 显式禁用)→ tool 返回 `makeError('todo_unavailable', ...)`。
- input.items 含同一 id 多次 → IDB 写入时后者覆盖前者(`replace` 内部去重最后一个)。文档化即可。
- 输入 items 为空数组 → 合法,清空列表 + emit `todo/updated` with `items: []`。
- IDB version migration 失败 → 走现有 DB 升级失败路径(已在仓里)。

## 测试策略(TDD)

### Kernel 单测

- `core/tools/todoWrite.test.ts`(新): 
  - replace 行为(全量覆盖、id 保留、新 id 生成、空列表)
  - 缺 todoStore → makeError
  - 缺 conversationId → makeError
- `core/protocol.test.ts`(扩): core TodoUpdated Zod 接受/拒绝
- `browser/storage/createIdbTodoStore.test.ts`(新): list/replace round-trip、按 conversation 隔离、createdAt 保留、updatedAt 更新
- `browser/rpc/protocol.test.ts`(扩): wire todo/updated Zod 接受/拒绝
- `browser/agentService.test.ts`(扩):
  - 调 todoWrite → emit todo/updated wire 事件
  - chat/loadConversation 末尾 emit 初始 todo/updated
  - ephemeral turn → todoWrite 报错且不 emit

### Consumer 单测

- `ui/TodoList.test.tsx`(新): 订阅 wire 事件、渲染、状态切换重渲染、空列表渲染

### 不做 live test

本 spec 验证 store + 协议 + UI,不涉及 LLM 行为本身。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| LLM 误提交不完整列表导致历史项被删 | UX 退化 | 工具 description 明确"全量替换,务必包含已有项";LLM 通常理解;不命中则只丢这次,下次 LLM 自己补回(它在每次 turn 之前看到上一次的 result.items) |
| 切 conversation 时 todo/updated 与 state/snapshot 顺序不当导致 UI 闪烁 | 体验问题 | agentService 在 emit state/snapshot **之后** emit todo/updated,UI 看到 messages 再看到 todos,与渲染顺序匹配 |
| IDB version bump 与现有 DB migrations 冲突 | 升级失败 | 用现有 openDb 模式,version 加 1,upgrade callback 只在 oldVersion < newVersion 时创建 store |
| 多个 todoWrite 调用并发(LLM 并行 tool calls,虽然当前 QueryEngine 顺序) | 状态不一致 | 当前 QueryEngine 顺序 execute,不会并发;若未来并行需要重新审视(本 spec 不解决) |
| Ephemeral 会话使用 todoWrite 失败 | LLM 拿到错误返回 | 文档化决策:ephemeral 不支持;tool 返回 makeError,LLM 适应 |
| `replace` IDB 事务读+写之间 race | 数据丢失 | 在单个 transaction 内 readwrite,IDB 保证原子 |

## 前向兼容

- 多 consumer:其他浏览器扩展实现自己的 `TodoStoreAdapter`(chrome.storage / 远程 / 内存)→ 零 fork kernel
- Plan mode(后续 sub-project):规划阶段产出 TodoItem[] → 用户审批后调 `todoStore.replace` 写入 → 进入执行;todoStore 已经是合适的写入端
- User 手动编辑(后续 sub-project):加 wire ClientCmd `todo/update`(来自 UI)→ agentService 路由到 todoStore;UI 在 TodoList 上加 checkbox/delete 按钮
- Sub-agent(后续 sub-project):每个子 agent 一个 conversationId,各管各的 todo 列表;或父 agent 拥有共享 todo,子 agent 只能读 — 视设计而定。本 spec 的 conversation-scoped 模型不预设这种关系
- Audit log:可选加 `auditAdapter` 在 `replace` 前后写入审计 — 不在本轮

## 文件清单

### Kernel(`packages/agent-kernel/`)

| 文件 | 改动 |
|---|---|
| `src/core/types.ts` | 加 TodoStatus;ToolExecContext 加 todoStore? + conversationId? |
| `src/adapters/index.ts` | 加 TodoItem / TodoWriteInput / TodoStoreAdapter |
| `src/core/tools/todoWrite.ts` | 新建 |
| `src/core/protocol.ts` | core AgentEvent 加 TodoUpdated |
| `src/browser/storage/db.ts` | DB version bump,加 'todos' object store |
| `src/browser/storage/createIdbTodoStore.ts` | 新建,~80 LOC |
| `src/browser/rpc/protocol.ts` | wire AgentEvent 加 TodoUpdated |
| `src/browser/agentService.ts` | 注入 ctx + emit + loadConversation 初始同步 |
| `src/browser/bootKernelOffscreen.ts` | options 加 todoStore?;默认装配 + 注入 todoWriteTool |
| `src/index.ts` | 导出新 symbols |
| `tests/core/tools/todoWrite.test.ts` | 新建 |
| `tests/core/protocol.test.ts` | 扩(2 cases) |
| `tests/browser/storage/createIdbTodoStore.test.ts` | 新建 |
| `tests/browser/rpc/protocol.test.ts` 或当前 wire 测试位 | 扩(2 cases) |
| `tests/browser/agentService.test.ts` | 扩(3 cases) |

### Consumer(`packages/mycli-web/`)

| 文件 | 改动 |
|---|---|
| `src/extension/ui/TodoList.tsx` | 新建,~60 LOC |
| `src/extension/content/ChatApp.tsx` | 加 todos state + 订阅 + 挂载 TodoList |
| `tests/extension/ui/TodoList.test.tsx` | 新建 |

### 估时

~250 LOC kernel + ~100 LOC consumer + ~200 LOC tests。比 #1 略大、比 #2 略小。

Plan 拟拆 6-7 个 task:
1. Types + adapter interface + index exports
2. `todoWriteTool` + 单测
3. core protocol Zod + wire protocol Zod + tests
4. `createIdbTodoStore` + DB migration + 单测
5. agentService 装配 + emit + loadConversation 同步 + 单测
6. bootKernelOffscreen options + 默认装配
7. Consumer TodoList UI + ChatApp 挂载 + 单测 + 全栈验证 + handoff
