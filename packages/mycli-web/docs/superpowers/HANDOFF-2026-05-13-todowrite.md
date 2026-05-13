# TodoWrite 端到端实施交接备忘 — 2026-05-13

## 一句话总结

Kernel 层实现了完整的 `TodoStoreAdapter` + `todoWriteTool` + IDB 持久化 + `todo/updated` 事件链；mycli-web 通过 `TodoList` 组件和 `ChatApp` 订阅完成最终 UI 渲染，**全链路打通，所有测试通过**（306 kernel 单测 + 51 consumer 单测），构建干净（368 模块，785 ms）。

## 跑了什么

7 个 task commit + 3 个 quality-fix commit，通过 subagent-driven-development 流程顺序执行。所有 commit 均在 `worktree-feat-todowrite` 分支：

| 标签 | Commit SHA | 说明 |
|---|---|---|
| T1 | `91e2329` | `TodoStoreAdapter` 接口 + `todoWriteTool` 核心实现 |
| T1-fix | `af69232` | todoWrite 工具打磨（T1 quality review 修复） |
| T2 | `7c4e920` | core `AgentEvent` + wire protocol 新增 `todo/updated` 事件类型 |
| T3 | `6803b59` | `createIdbTodoStore` + IDB DB v2 migration（新增 `todos` object store） |
| T4 | `9e2bea9` | `agentService` 接线 `todoStore`，在 `todoWrite` 成功后发出 `todo/updated` |
| T5-fix1 | `6626cd2` | `bootKernelOffscreen` 修复：`chat/loadConversation` 正确路由到 `handleCommand` |
| T5-fix2 | `916e859` | `bootKernelOffscreen` 修复：正确接线 `todoStore`，`handleCommand` 捕获 list 错误 |
| T6 | `2fb5630` | `bootKernelOffscreen` 默认懒建 IDB todoStore，并自动注册 `todoWriteTool` |
| T6-fix | `faf199c` | `bootKernelOffscreen` tools 参数可选；todoStore 为 null 时跳过工具注册 |
| T7 | `d0b702d` | `TodoList` UI 组件 + `ChatApp` 订阅 `todo/updated` 事件渲染列表 |

## 如何试一下

### 方法 A — 跑 kernel 单测（无需凭据）

```bash
cd packages/agent-kernel
bun run test
# 预期：306 tests passed（50 个测试文件）
```

TodoWrite 相关覆盖在以下测试文件：

- `tests/core/tools/todoWrite.test.ts` — `todoWriteTool` 5 个用例（set / append / clear / 参数校验 / storeAdapter 调用）
- `tests/browser/storage/createIdbTodoStore.test.ts` — `createIdbTodoStore` 6 个用例（读写、持久化、db v2 migration）
- `tests/browser/agentService.test.ts` — 新增 3 个 todo flow 用例（`todo/updated` 事件触发、非 todoWrite 工具不触发、`ok: false` 不触发）

### 方法 B — 加载扩展 + 提示 LLM

1. 在 `packages/mycli-web` 执行 `bun run build`，在 Chrome 加载 `dist/` 目录（开发者模式 → 加载已解压的扩展程序）。
2. 打开任意页面，激活侧边栏（点击工具栏图标或使用快捷键）。
3. 在对话框输入提示，例如："**帮我制定一个学习 TypeScript 的待办事项清单**"。
4. LLM 在 tool list 中发现 `todoWrite`，调用工具写入 todo 项。
5. 侧边栏 `TodoList` 组件实时更新，显示 checkbox 列表。
6. 刷新页面后打开扩展侧边栏，`createIdbTodoStore` 会从 IDB 恢复上次的 todo 列表（跨会话持久化）。

## 改了哪些文件

### Kernel adapters/ 层（接口定义）

- `src/adapters/TodoStoreAdapter.ts` — 新增，`TodoStoreAdapter` 接口（`readAll` / `writeAll`），以及 `TodoItem` 类型定义
- `src/adapters/index.ts` — 重新导出 `TodoStoreAdapter` / `TodoItem`

### Kernel core/ 层（纯逻辑，零浏览器依赖）

- `src/core/tools/todoWrite.ts` — 新增，`todoWriteTool`：接受 `items: TodoItem[]`，写入 adapter，返回序列化结果；通过工厂函数接收 `TodoStoreAdapter`
- `src/core/protocol.ts` — core `AgentEvent` union 新增 `todo/updated` 变体，携带 `items: TodoItem[]`
- `src/core/types.ts` — `ToolDefinition` 保持不变（todoWrite 无需 `requiresApproval`）
- `src/index.ts` — 重新导出新公共类型

### Kernel browser/ 层（Chrome 适配，不引用 mycli-web）

- `src/browser/storage/createIdbTodoStore.ts` — 新增，`createIdbTodoStore(db)`：基于 IDB `todos` object store 实现 `TodoStoreAdapter`；含懒初始化包装器
- `src/browser/storage/db.ts` — DB schema 升级到 v2，新增 `todos` object store（`keyPath: 'id'`）
- `src/browser/rpc/protocol.ts` — wire `KernelEvent` union 新增 `todo/updated` 变体
- `src/browser/agentService.ts` — `RunTurnOptions` 新增 `todoStore?: TodoStoreAdapter`；`runTurn` 在 `tool/end` 事件后，若工具名为 `todoWrite` 且结果 `ok: true`，向 port 发出 `todo/updated` wire 事件
- `src/browser/bootKernelOffscreen.ts` — `KernelOffscreenOptions.tools` 改为可选；新增 `todoStore?` 选项；默认行为：无 todoStore 时懒建 IDB 实例并自动注册 `todoWriteTool`

### Consumer 层（mycli-web 扩展）

- `src/extension/ui/TodoList.tsx` — 新增，`TodoList` React 组件：接受 `items: TodoItem[]`，渲染带 checkbox 的任务列表
- `src/extension/content/ChatApp.tsx` — 订阅 `todo/updated` wire 事件，维护 `todoItems` 状态，在侧边栏渲染 `<TodoList>`

## 跨浏览器扩展可迁移性

kernel 的 TodoWrite 层设计为**完全可移植**：

1. 任何 MV3 扩展只需传入实现了 `TodoStoreAdapter` 接口（两个方法：`readAll` / `writeAll`）的对象给 `bootKernelOffscreen`，即可替换后端存储（如 `chrome.storage.sync`、远程 API、内存 mock）。
2. 若不传 `todoStore`，`bootKernelOffscreen` 默认懒建 IDB 实例并自动注册 `todoWriteTool`，zero-config 开箱即用。
3. UI 层完全解耦：消费方监听 `todo/updated` wire 事件（`items: TodoItem[]`），自行渲染列表，不依赖任何 React 组件。
4. `todoWriteTool` 的注册与否取决于是否提供了有效的 `todoStore`，消费方可通过不提供 store 来彻底禁用该工具。

T7 的 grep 防护已验证：

```
grep core/ → "core is clean"      # 零 chrome / DOM / @ext 引用
grep browser/ → "browser is mycli-clean"   # 零 mycli-web / @ext 引用
```

## 已知问题

1. **todoWriteTool 不在任何 system prompt 中声明**：LLM 必须通过 tool list 自行发现该工具；若 system prompt 未引导 LLM 规划任务，LLM 可能不会主动调用 `todoWrite`。
2. **无用户编辑 UI**：TodoList 仅供只读显示，用户无法在扩展侧边栏直接增删改 todo 项；当前是单向数据流（LLM 写 → UI 读）。
3. **懒建 IDB 的失败状态不清理**：`createIdbTodoStore` 的懒包装器在 `openDb` promise 被 reject 后不会清除 promise 缓存，导致后续调用永远拿到同一个 rejected promise；IDB 瞬时失败后需刷新页面才能恢复。
4. **a11y 细节待打磨**：`TodoList` 中已完成项通过 `opacity: 0.5` 降低可见度（而非颜色对比），缺少 `role="list"` 声明，标题未使用语义 `<h3>`；这些无障碍优化推迟到 UI 打磨阶段处理。

## 下一步

Brainstorming 规划了 5 个子项目，本分支（Plan + TodoWrite）对应 #3。其余 2 个还在 pending，每个开始前需要跑 `superpowers:brainstorming`：

4. **Sub-agent / Fork** — 多 agent fork 时，子 agent 并行执行 subtask，汇聚结果后更新 todo 状态。需要 agentService fork API + coordinator 层级代理。
5. **多 Tab 编排** — 多 tab 并发运行时，统一的 todo 列表跨 tab 同步，避免多个侧边栏状态不一致。涉及 service worker broadcast + shared IDB + tab 间消息路由。

三个原则不变：kernel-first（先扩 API，再做壳）、不改 consumer 仅加壳、每个 task 对应一个 TDD commit。
