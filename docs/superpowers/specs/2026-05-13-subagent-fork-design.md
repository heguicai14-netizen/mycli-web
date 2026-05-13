# Sub-agent / Fork —— 设计稿

**日期:** 2026-05-13
**Sub-project:** mycli-web agent 能力路线图 #4
**状态:** 已批准,可进入 plan 阶段

## 1. 目标与非目标

### 目标(in-scope)

1. **kernel 提供 spawn 机制** —— 主 agent 可调用 `Task` tool 派生独立子 agent。子 agent 跑自己的 LLM chat loop,context 完全隔离,最终的 assistant 文字作为 `Task` tool 的 result 返回。主 agent 同一 turn 内多次调用 `Task` 时,通过 LLM 原生的 parallel-tool-calls 能力天然并发执行;kernel 不再发明额外的并发层。
2. **由 consumer 定义的 `SubagentType` 注册** —— kernel 暴露注册形状 `{ name, description, systemPrompt, allowedTools, maxIterations?, model?, maxConcurrent?(预留) }`。kernel **零内置类型**,consumer 把类型数组通过 `bootKernelOffscreen({ subagentTypes })` 注入。
3. **完整 UI 透明** —— 子 agent 内部每条 message、tool call、tool result 都通过新增的 `subagent/*` `AgentEvent` 变体广播。每个事件带 `subagentId`;`subagent/started` 额外带 `parentTurnId` 和 `parentCallId`,让 UI 能把子 agent 卡片挂到正确的主 agent tool-call 卡片下面。
4. **数据隔离** —— 每个子 agent 拿独立 `subagentId` 作为 `ToolExecContext.conversationId`,隔离 TodoWrite 状态。Approval 规则和 settings 仍**共享**(全局)。
5. **可迁移** —— 零 `mycli-web` 假设。任何浏览器扩展 consumer 都可以调 `bootKernelOffscreen` 时塞自己的 subagent 类型,直接获得一个能用的 `Task` tool。mycli-web v1 注册 1 个 reference 类型(`general-purpose`)作为示范。
6. **mycli-web UI** —— 在 Shadow-DOM 聊天面板里渲染可展开的子 agent 卡片。并发的多个子 agent 并排展示。

### 非目标(v1 不做)

- **递归 spawn**。子 agent 的 tool registry 无条件 filter 掉 `Task`。
- **子 agent 中间消息持久化**。只有最终 `tool_result` 文字(它本来就是主对话的一部分)通过现有 `MessageStoreAdapter` 落盘。事件 schema 带 `subagentId` / `parentTurnId` / `parentCallId` 字段,留给 consumer 自己订阅并落盘 —— kernel 不管。
- **wall-clock 超时**。`fetchTimeoutMs`(每次请求级)+ `maxIterations`(每个子 agent 级)+ 用户手动取消已经覆盖,不需要全局 timeout。
- **跨 service-worker 重启续跑**。offscreen 文档销毁 → 进行中的子 agent 视为 aborted。
- **子 agent 加载 skills、子-子 agent、独立 LLM provider**。统统延后。
- **`maxConcurrent` 强制执行**。`SubagentType` 字段位预留,v1 不读取。

## 2. 架构总览

### 2.1 代码分布

```
packages/agent-kernel/                        ← 所有 kernel 改动
├── src/core/
│   ├── subagent/                             ← 新目录
│   │   ├── SubagentType.ts                   ← 类型定义 + registry 构造器
│   │   ├── Subagent.ts                       ← 单次运行器
│   │   ├── taskTool.ts                       ← 工厂:基于 registry 构 Task tool
│   │   └── index.ts
│   ├── types.ts                              ← 加 SubagentId,扩 ToolExecContext
│   ├── protocol.ts                           ← 加 5 个 AgentEvent 变体
│   └── index.ts                              ← re-export SubagentType, SubagentId
├── src/browser/
│   ├── agentService.ts                       ← forward Subagent 事件 → AgentEvent
│   ├── bootKernelOffscreen.ts                ← 接收 subagentTypes,装配 Task tool
│   └── rpc/protocol.ts                       ← wire 端 5 个变体
└── tests/core/subagent/…                     ← 4–5 个测试文件

packages/mycli-web/                           ← reference consumer
├── src/extension-tools/subagentTypes/        ← 新目录
│   ├── generalPurpose.ts
│   └── index.ts
├── src/extension/offscreen.ts                ← 把 subagentTypes 传进 boot
├── src/extension/ui/
│   ├── SubagentCard.tsx                      ← 新组件
│   ├── MessageList.tsx 或 ToolCallCard.tsx   ← 把 Task tool call 路由到 SubagentCard
│   └── ChatApp.tsx                           ← 订阅 subagent/* 事件,维护 state map
└── tests/extension/…                         ← 1–2 个集成测试
```

### 2.2 数据流(主 agent 在同一 turn 派 2 个 Task)

```
主 QueryEngine
  ├─ LLM 输出 2 个 tool_use block(Task, Task)
  ├─ ToolRegistry.execute("Task", …) × 2     ← 当前代码已经是 Promise.all
  │   每次 Task 调用:
  │     ├─ 从 registry resolve 出 type
  │     ├─ new Subagent({ id, parentTurnId, parentCallId, type, … }).run()
  │     │     ├─ 从主 toolRegistry filter 掉 Task,与 allowedTools 取交集
  │     │     ├─ 构造 child ToolExecContext(conversationId = subagentId,…)
  │     │     ├─ 构造 child AgentSession(system = type.systemPrompt,首条 user = prompt)
  │     │     ├─ child AbortController,parent.signal → child.signal
  │     │     ├─ child QueryEngine.run()
  │     │     │     ├─ emit subagent/started
  │     │     │     ├─ 每个 LLM step: emit subagent/message / subagent/tool_call / subagent/tool_end
  │     │     │     └─ 结束时: emit subagent/finished
  │     │     └─ 返回最终 assistant 文字 → ToolResult.ok({ data: text })
  │     ↓
  │   两个 ToolResult 回到主 QueryEngine
  └─ 主 LLM 看到两个 tool_result,继续推理
```

关键:`Subagent` **复用** `QueryEngine`,不发明新 loop —— 它只是构造一个 fresh session(filtered tools、新的 conversationId、child AbortSignal)。

## 3. 公共 API

### 3.1 `SubagentType`(`core/subagent/SubagentType.ts`)

```ts
export interface SubagentType {
  /** LLM 看到的类型名。须匹配 /^[a-z][a-z0-9_-]*$/。作为 Task input 的 enum */
  readonly name: string

  /** 1-2 句话:LLM 用来决定选什么 type。会被拼进 Task tool description */
  readonly description: string

  /** 子 agent 的 system prompt。完全 consumer 定义 */
  readonly systemPrompt: string

  /**
   * 子 agent 可用的 tool 名字白名单。
   * Task tool 一定会被 filter 掉(禁递归)。
   * '*' 表示"主 agent 的全部 tool 减 Task";否则与主 agent 现有 tool 取交集。
   */
  readonly allowedTools: '*' | readonly string[]

  /** 覆盖默认 maxIterations(不传则用 QueryEngine 默认值) */
  readonly maxIterations?: number

  /** 覆盖 model 名字。共享主 agent 的 OpenAI client(baseUrl/apiKey 不变) */
  readonly model?: string

  /** 预留给未来扩展。v1 不强制执行 */
  readonly maxConcurrent?: number
}

export type SubagentTypeRegistry = ReadonlyMap<string, SubagentType>

/** 重名或名字格式非法时抛错 */
export function buildSubagentTypeRegistry(
  types: readonly SubagentType[],
): SubagentTypeRegistry
```

### 3.2 `bootKernelOffscreen` 新增选项

```ts
interface BootKernelOffscreenOptions {
  // …已有字段
  /**
   * 可选。非空数组 → 注册 Task tool(以此 registry 驱动)。
   * 不传或空数组 → 不注册 Task tool,kernel 行为与今日完全相同。
   */
  subagentTypes?: readonly SubagentType[]
}
```

### 3.3 `ToolExecContext` 扩展(`core/types.ts`)

```ts
export type SubagentId = string & { readonly __brand: 'SubagentId' }

export interface ToolExecContext {
  // …已有字段
  /** 仅当 tool 调用发生在子 agent 内部时存在;主 agent 调时 undefined */
  readonly subagentId?: SubagentId
}
```

### 3.4 `Subagent` 运行器(内部,不 re-export)

```ts
export interface SubagentRunOptions {
  readonly id: SubagentId
  readonly type: SubagentType
  readonly parentTurnId: string
  readonly parentCallId: string         // 主 agent 调 Task 的那次 tool_use id
  readonly userPrompt: string
  readonly userDescription: string
  readonly parentSignal: AbortSignal
  readonly parentCtx: ToolExecContext   // 主 agent 的 ctx(settings/approval/todoStore 等)
  readonly llm: OpenAICompatibleClient
  readonly emit: (ev: SubagentEvent) => void
}

export interface SubagentRunResult {
  readonly text: string
  readonly iterations: number
}

export class Subagent {
  constructor(private opts: SubagentRunOptions) {}
  async run(): Promise<SubagentRunResult>  // 抛 AbortError 或 SubagentFailedError
}

export class SubagentFailedError extends Error {
  readonly code: 'max_iterations_no_result' | 'llm_error' | 'subagent_failed'
  readonly cause?: unknown
}
```

### 3.5 `Task` tool 工厂(`core/subagent/taskTool.ts`)

```ts
export function buildTaskTool(
  registry: SubagentTypeRegistry,
  llm: OpenAICompatibleClient,
): ToolDefinition<TaskInput, string>
```

返回的 tool:

- `name: 'Task'`
- `description` —— 由 registry 动态拼出,示例:

  ```
  Spawns a sub-agent to handle a focused sub-task with isolated context.
  Available types:
  - general-purpose: General-purpose agent for multi-step research and synthesis.

  Use the Task tool when a sub-task is well-defined and self-contained,
  especially if you'd otherwise pollute your own context with intermediate steps.
  You cannot nest Task calls.
  ```

- `inputSchema`:

  ```ts
  z.object({
    subagent_type: z.enum([...types.map(t => t.name)]),
    description:   z.string().min(1).max(120),
    prompt:        z.string().min(1),
  })
  ```

- `execute(input, ctx)`:
  1. 生成 `subagentId = uuid()`。
  2. resolve `type = registry.get(input.subagent_type)`。
  3. `new Subagent({ id: subagentId, type, parentTurnId: ctx.turnId, parentCallId: ctx.callId, userPrompt: input.prompt, userDescription: input.description, parentSignal: ctx.signal, parentCtx: ctx, llm, emit }).run()`。
  4. 成功 → `makeOk(result.text)`。
  5. `AbortError` → 重抛(QueryEngine 自己处理)。
  6. `SubagentFailedError` → `makeError('subagent_failed', \`Subagent ${type.name} failed: ${err.message}. The sub-task was not completed.\`, /*retryable*/ false)`。

> **kernel 前置条件:** `ctx.turnId` 和 `ctx.callId` 必须在 `ToolExecContext` 上。如果今天还没有,引入 Task tool 的同一个 task 内补上 —— 它们是标准 agent-loop 标识符,后面几个特性都会要。

## 4. 事件协议

### 4.1 Core 变体(`core/protocol.ts`,加入 `AgentEvent` union)

```ts
// 子 agent 启动
{ type: 'subagent/started',
  subagentId: SubagentId,
  parentTurnId: string,
  parentCallId: string,        // 主 agent 调 Task 的 tool_use id
  subagentType: string,
  description: string,
  prompt: string,
  startedAt: number }

// 子 agent 内部的一条 assistant message
{ type: 'subagent/message',
  subagentId: SubagentId,
  role: 'assistant',
  content: ContentBlock[],
  ts: number }

// 子 agent 内部的 tool 调用开始
{ type: 'subagent/tool_call',
  subagentId: SubagentId,
  callId: string,
  toolName: string,
  args: unknown,
  ts: number }

// 子 agent 内部的 tool 调用结束
{ type: 'subagent/tool_end',
  subagentId: SubagentId,
  callId: string,
  ok: boolean,
  content?: unknown,
  error?: { code: string; message: string },
  ts: number }

// 子 agent 结束(成功 / 失败 / 取消)
{ type: 'subagent/finished',
  subagentId: SubagentId,
  ok: boolean,
  text?: string,                                // ok: true 时有
  error?: { code: string; message: string },    // ok: false 时有
  iterations: number,
  finishedAt: number }
```

### 4.2 Wire 变体(`browser/rpc/protocol.ts`)

同样 5 个变体,每个套上标准 envelope(`id`、`sessionId`、`ts`),与 wire 协议现有惯例一致。用 Zod 验证后加入 wire 端 `AgentEvent` 判别联合。

### 4.3 事件顺序保证

- 同一个 `subagentId` 下,`subagent/started` 一定是**第一个** `subagent/*` 事件。
- 同一个 `subagentId` 下,`subagent/finished` **恰好出现一次**。
- 该 id 的其他 `subagent/*` 事件全部严格出现在 `started` 和 `finished` 之间。
- 主 agent 端对应 `Task` callId 的 `tool_end` **晚于**对应的 `subagent/finished`。

### 4.4 时序示例(并发 2 个 Task)

```
turn/start
message              (主 agent 输出 2 个 tool_use)
tool_call            (Task, callId=cA)
tool_call            (Task, callId=cB)
subagent/started     (id=A, parentCallId=cA)
subagent/started     (id=B, parentCallId=cB)
subagent/message     (id=A, …)                ← 并发交错
subagent/tool_call   (id=A, …)
subagent/message     (id=B, …)
subagent/tool_end    (id=A, …)
subagent/finished    (id=A, ok=true, text=…)
tool_end             (Task, callId=cA, ok=true, content=A.text)
subagent/finished    (id=B, ok=true, text=…)
tool_end             (Task, callId=cB, ok=true, content=B.text)
message              (主 agent 拿到两个 tool_result 后继续)
…
turn/end
```

## 5. 取消、失败、限制

### 5.1 取消传播

- 每个 `Subagent` 自带 `AbortController`。监听 `parentSignal.abort`,触发后调 `childController.abort(parentSignal.reason)`。
- 用户点 UI"停止"按钮(wire `cancelTurn`)→ 主 `AgentSession.signal` abort → 所有进行中的子 agent 同步 abort → 子 LLM fetch 和 tool execution 全部中止。
- 被 abort 时 emit `subagent/finished({ ok: false, error: { code: 'aborted', message: 'Sub-agent aborted' } })`,UI 可以渲"已取消"badge。

### 5.2 单个子 agent 失败

- 一个子 agent 失败**不影响**并发的兄弟(各自独立 promise + 独立 AbortController;controller 链是 parent → 各 child,child 之间无连接)。
- 失败通过 `tool_result.is_error = true` 反馈给主 LLM,标准文案:

  ```
  Subagent <type> failed: <reason>. The sub-task was not completed.
  ```

  主 LLM 自己决定重试、换 type、放弃报告等。

### 5.3 `maxIterations`

- 子 agent 用 `type.maxIterations ?? defaultMaxIterations`(kernel 全局默认,沿用 `QueryEngine`)。
- "跑完 maxIterations 仍没出最终 assistant 文字" → 抛 `SubagentFailedError('max_iterations_no_result')`。
- "跑完 maxIterations,有 assistant 文字但还想继续 tool call" → 视为正常完成(LLM 已经给出答案)。与现有 `QueryEngine` 语义一致。

### 5.4 子 agent 内部的 tool error

- tool 内部 `ToolResult.error` **不**算子 agent 失败。与主 agent 路径一致:错误通过 `tool_result.is_error = true` 喂回子 LLM,由子 LLM 自己决定下一步。
- 只有 tool 错误累积到子 LLM 始终给不出最终文字、`maxIterations` 跑光,才算子 agent 整体失败。

### 5.5 不内置 wall-clock 超时

- per-request `fetchTimeoutMs` + `maxIterations` + 手动取消已经覆盖所有需要。不引入额外全局 timeout。

### 5.6 并发上限

- v1 **kernel 不限**。`Promise.all` 配合主 LLM parallel-tool-calls 是唯一通路,主 LLM 实际一个 turn 极少超过 4 个 `Task`。
- `SubagentType.maxConcurrent` 字段位预留,v1 不读,加注释 `// reserved for future use`,避免后期破坏 wire schema。

## 6. Consumer 集成(mycli-web)

### 6.1 Reference 类型 —— `general-purpose`

`packages/mycli-web/src/extension-tools/subagentTypes/generalPurpose.ts`:

```ts
import type { SubagentType } from 'agent-kernel'

export const generalPurpose: SubagentType = {
  name: 'general-purpose',
  description:
    'General-purpose agent for multi-step research, page reading, ' +
    'and synthesis tasks. Use when you need to investigate a topic ' +
    'across pages without polluting your own context.',
  systemPrompt: `You are a focused sub-agent dispatched to handle one self-contained sub-task.

Your final reply will be returned to your parent agent as the result of the Task tool. Make it concise, factual, and directly answer what was asked. Do NOT chat — output the answer.

Available tools: readPage, readSelection, querySelector, screenshot, listTabs, fetchGet, todoWrite.

You cannot dispatch further sub-agents.`,
  allowedTools: [
    'readPage', 'readSelection', 'querySelector',
    'screenshot', 'listTabs', 'fetchGet', 'todoWrite',
  ],
  maxIterations: 15,
}
```

`packages/mycli-web/src/extension-tools/subagentTypes/index.ts`:

```ts
export { generalPurpose } from './generalPurpose'
import { generalPurpose } from './generalPurpose'
export const allSubagentTypes = [generalPurpose] as const
```

### 6.2 Offscreen 接线

`packages/mycli-web/src/extension/offscreen.ts`:

```ts
import { allSubagentTypes } from '@ext-tools/subagentTypes'

bootKernelOffscreen({
  // …已有选项
  subagentTypes: allSubagentTypes,
})
```

### 6.3 UI:`SubagentCard.tsx`

新组件。主 agent 消息列表里遇到 `toolName === 'Task'` 的 tool_call 时渲染。卡片通过 `parentCallId → subagentId` 映射(由 `subagent/started` 事件构建)订阅对应 `subagentId`,渲染:

- 收起态:类型 badge、短 `description`、状态(running / done / failed / aborted)、完成后显示最终文字预览。
- 展开态:子 agent 完整时间线(message + tool call),复用主 chat 的同款展示组件。

### 6.4 ChatApp 状态

```ts
interface SubagentState {
  id: string
  type: string
  description: string
  parentCallId: string
  status: 'running' | 'finished' | 'failed' | 'aborted'
  messages: ContentBlock[][]
  toolCalls: Map<string, { name: string; args: unknown; result?: unknown; error?: unknown }>
  finalText?: string
  error?: { code: string; message: string }
}

const [subagents, setSubagents] = useState<Map<string, SubagentState>>(new Map())
const [callIdToSubagentId, setCallIdToSubagentId] = useState<Map<string, string>>(new Map())
```

事件处理:

| 事件 | 动作 |
|---|---|
| `subagent/started` | 写入 `subagents` map;`callIdToSubagentId[parentCallId] = subagentId` |
| `subagent/message` | `messages[]` 追加 `content` |
| `subagent/tool_call` | `toolCalls[callId] = { name, args }` |
| `subagent/tool_end` | 更新 `toolCalls[callId]` 的 `result` 或 `error` |
| `subagent/finished` | 更新 `status`、`finalText` 或 `error`,保留 entry 作历史 |
| `chat/turn_reset`(已有) | 两个 map 都清空(沿用 #3 的 `resetTurnState` 模式) |

### 6.5 主 agent Task 卡片渲染

`MessageList.tsx`(或 `ToolCallCard.tsx`):遍历 tool_call 时,若 `toolName === 'Task'`,查 `subagentId = callIdToSubagentId.get(callId)`;命中 → 渲 `<SubagentCard state={subagents.get(subagentId)} />`;否则 fallback 到通用 `<ToolCallCard>`(turn 早期 `subagent/started` 还没到时的过渡状态)。

## 7. 测试策略

### 7.1 Kernel(`packages/agent-kernel/tests/core/subagent/`)

1. **`SubagentType.test.ts`** —— `buildSubagentTypeRegistry`:正常路径、重名抛错、名字格式非法抛错、空数组返回空 map。
2. **`taskTool.test.ts`** —— 工厂行为:description 包含所有 type 名;input schema 拒收未知 `subagent_type`;空 registry 由 `bootKernelOffscreen` 跳过 Task tool 注册(在测试 5 验证)。
3. **`Subagent.test.ts`** —— 用 mocked `OpenAICompatibleClient` + 内存 tool registry:
   - 成功路径:LLM 输出一条 assistant 文字 → 返回。
   - 多轮 tool 调用 → 返回最终文字。
   - `maxIterations` 跑光无文字 → 抛 `SubagentFailedError('max_iterations_no_result')`。
   - LLM 抛错 → 抛 `SubagentFailedError('llm_error')`。
   - 父 signal abort → 子同步 abort → 重抛 `AbortError`。
   - tool 过滤:即使 `allowedTools: '*'`,Task tool 也一定被移除。
   - tool 过滤:白名单外的 tool 子 agent 看不到。
   - 子 `ToolExecContext.conversationId === subagentId`。
   - emit 顺序:`started` → (`message` / `tool_call` / `tool_end`)\* → `finished`,`started` 和 `finished` 各恰好一次。
4. **`agentService.subagent.test.ts`** —— 通过 `agentService` 端到端:
   - 脚本化主 LLM 派 1 个 Task → 断言 wire 事件顺序:`tool_call(Task)` → `subagent/started` → `subagent/message` → `subagent/finished` → `tool_end(Task, content=text)`。
   - 并发 2 个 Task → 两条 `subagent/*` 流按 id 分流,无串号。
5. **`bootKernelOffscreen.subagent.test.ts`**:
   - 不传 `subagentTypes` → Task tool 未注册,registry 不含 `Task`。
   - `subagentTypes: []` → 同上。
   - `subagentTypes: [generalPurpose]` → Task tool 注册,description 含 `'general-purpose'`。

### 7.2 Consumer(`packages/mycli-web/tests/`)

6. **`subagentTypes.test.ts`** —— 静态守护:`generalPurpose.allowedTools` 里的每个 tool 名都真实存在于 extension-tools registry。防 rename 漂移。
7. **`ChatApp.subagent.test.tsx`** *(可选,如果 UI 测试基础设施太重可推到 follow-up)* —— 喂入脚本化事件流,断言 `SubagentCard` 渲染 + 状态切换。

### 7.3 覆盖率目标

- kernel 新增代码行覆盖率 ≥ 90%。
- 关键路径(spawn / cancel / fail)行覆盖 100%。

### 7.4 不打真实 LLM

全部测试 mock `OpenAICompatibleClient`。沿用现有 `tests/setup.ts` 的 `fake-indexeddb` 和 `chrome.*` mock。若 kernel tests 里还没有 `mockOpenAIClient(scriptedResponses)` helper,作为 Subagent 测试 task 的一部分补上。

## 8. Open Questions / 风险

| 项 | 风险 | 缓解 |
|---|---|---|
| `ctx.turnId` / `ctx.callId` 可能还不在 `ToolExecContext` 上 | Task tool 无法 emit `parentTurnId` / `parentCallId` | 第一个实施 task 同时补这两个字段(改动小,纯 kernel),`agentService` 负责填值 |
| LLM provider 的 parallel-tool-calls 语义 | OpenAI-兼容 endpoint 若不支持 `parallel_tool_calls`,子 agent 会串行 | 不是 kernel 关心的事 —— 已经是 LLM 客户端属性。子 agent 机制仍工作,只是每次一个 |
| 子 agent 事件量大 | UI / wire 开销 | `subagent/*` 事件量等于子 agent 自己的 message 流,无放大。v1 可接受 |
| UI `parentCallId → subagentId` 竞态 | 主 agent `tool_call` 比 `subagent/started` 先到 | UI 在映射建立前用通用 `<ToolCallCard>` 占位,映射就绪后切到 `<SubagentCard>` |

## 9. 明确排除(再次声明)

- 递归 Task 调用
- 子 agent 中间消息持久化到 IndexedDB
- wall-clock 超时
- 跨 service-worker 重启续跑
- 每个子 agent 独立 LLM provider(只支持 `model` 名字覆盖,共享同一 client)
- 子 agent 内部 skills 加载
- 自定义 subagent type 的 UI 管理界面(settings 页等)
- `maxConcurrent` 强制执行
