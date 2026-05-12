# User Approval Flow 实施交接备忘 — 2026-05-12

## 一句话总结

Kernel 层实现了完整的 `ApprovalCoordinator` + `ApprovalAdapter` + `QueryEngine` 门控；mycli-web 通过 `MycliApprovalAdapter` 桥接 kernel 到规则库，并提供 `ApprovalModal` 弹窗 UI，**全链路打通，所有测试通过**（284 kernel 单测 + 47 consumer 单测），构建干净。

## 跑了什么

9 个 task + 4 个 quality-fix commit，通过 subagent-driven-development 流程顺序执行。所有 commit 均在 `worktree-feat-approval-flow` 分支：

| 标签 | Commit SHA | 说明 |
|---|---|---|
| T1 | `c8bf149` | `ApprovalCoordinator` + `ApprovalAdapter` 接口 + `ToolDefinition` 字段 |
| T1-fix | `6f527b8` | `ApprovalCoordinator` clean abort listener + cancelSession 时清理 sticky |
| T2 | `1b8219a` | core `AgentEvent` 新增 `approval/requested` 事件类型 |
| T3 | `141c83d` | `QueryEngine` 对 `requiresApproval` 工具进行 coordinator 门控 |
| T3-fix | `cd32bbf` | `QueryEngine` deny 路径补发配对的 `tool_executing` 事件 |
| T4 | `b6bb8e6` | `buildActiveTabApprovalContext` browser 工具函数 |
| T4-fix | `a327afb` | `activeTabContext` 过滤不透明来源字符串 `'null'` |
| T5 | `4187561` | `agentService` 接入 `ApprovalCoordinator` + wire reply 路由 |
| T5-fix | `e27485e` | `bootKernelOffscreen` 传入 `approvalAdapter` + JSDoc 修正 |
| T6 | `635eea9` | `MycliApprovalAdapter` 桥接 kernel 到 `rules.ts` |
| T7 | `8bfa60c` | `approvalContextBuilder` 组合 kernel 工具 + DOM selector |
| T8 | `9407d4d` | `ApprovalModal` UI + offscreen / ChatApp 接线 |
| T8-fix | `e3f4395` | `ApprovalModal` z-index 修正 + `aria-modal` 无障碍属性 |

## 如何试一下

### 方法 A — 跑 kernel 单测（无需凭据）

```bash
cd packages/agent-kernel
bun run test
# 预期：284 tests passed
```

审批流程覆盖在以下测试文件：

- `tests/core/approval/coordinator.test.ts` — `ApprovalCoordinator` 15 个用例（创建请求、approve/deny、abort 清理、sticky 策略等）
- `tests/core/queryEngine.approval.test.ts` — `QueryEngine` 门控 7 个用例（请求拦截、approve 放行、deny 拒绝、结果传递）
- `tests/browser/activeTabContext.test.ts` — `buildActiveTabApprovalContext` 7 个用例

### 方法 B — 加载扩展 + 标记工具 requiresApproval

1. 在 `packages/mycli-web` 执行 `bun run build`，在 Chrome 加载 `dist/` 目录。
2. 找到任意 tool 定义，给 `ToolDefinition` 加上 `requiresApproval: true`。
3. 触发该工具调用：内容脚本侧边栏会弹出 `ApprovalModal`，显示工具名 + 参数。
4. 点击「允许」→ 工具正常执行；点击「拒绝」→ 工具返回 `denied` 错误，agent stream 继续。

注意：当前无任何内置工具标记 `requiresApproval`（per spec，留给消费方按需设置）。

## 改了哪些文件

### Kernel core/ 层（纯逻辑，零浏览器依赖）

- `src/core/approval.ts` — 新增，`ApprovalAdapter` 接口 + `ApprovalCoordinator` 实现 + `ApprovalContext` / `ApprovalOutcome` / `RuleAction` 类型
- `src/core/types.ts` — `ToolDefinition` 新增 `requiresApproval?: boolean` 字段
- `src/core/protocol.ts` — core `AgentEvent` union 新增 `approval/requested` 变体
- `src/core/QueryEngine.ts` — `requiresApproval` 工具进入 coordinator 门控，deny 路径补发 `tool_executing`
- `src/core/AgentSession.ts` — 传递 `approvalAdapter` 给 coordinator
- `src/core/createAgent.ts` — `AgentOptions` 新增 `approvalAdapter?` 字段
- `src/index.ts` — 重新导出新公共类型

### Kernel browser/ 层（Chrome 适配，不引用 mycli-web）

- `src/browser/activeTabContext.ts` — `buildActiveTabApprovalContext` 工具函数，从活跃 tab 构建 `ApprovalContext`；过滤 `'null'` 来源
- `src/browser/agentService.ts` — `runTurn` 接受 `approvalAdapter` 选项，接线 `ApprovalCoordinator`，路由 wire reply
- `src/browser/bootKernelOffscreen.ts` — `KernelOffscreenOptions` 新增 `approvalAdapter?`，转发给 `agentService`

### Consumer 层（mycli-web 扩展）

- `src/extension/mycliApprovalAdapter.ts` — 新增，`MycliApprovalAdapter` 实现，查询 `rules.ts` 决定 ask / allow / deny；发布 `approval/requested` wire 事件等待 UI 回复
- `src/extension/approvalContextBuilder.ts` — 新增，组合 `buildActiveTabApprovalContext` + CSS selector 构建上下文
- `src/extension/ui/ApprovalModal.tsx` — 新增，React 弹窗组件；显示工具名 + 参数；收听 `approval/requested` 事件，回调 resolve/reject；`z-index: 2147483647` + `aria-modal`
- `src/extension/offscreen.ts` — 传入 `approvalAdapter` 给 `bootKernelOffscreen`
- `src/extension/content/ChatApp.tsx` — 挂载 `<ApprovalModal>`

## 跨浏览器扩展可迁移性

kernel 的 approval 层设计为**完全可移植**：

1. 任何 MV3 扩展只需实现 `ApprovalAdapter` 接口（一个 `check(context, tool)` 方法）即可接入。
2. Kernel 提供 `buildActiveTabApprovalContext(tab)` 工具函数，消费方无需自行解析 tab 信息。
3. UI 层完全解耦：消费方监听 `approval/requested` wire 事件，通过 `port.postMessage` 回复 `approval/reply` 即可，不依赖任何 React 组件。

T9 的 grep 防护已验证：

```
grep core/ → "core is clean"   # 零 chrome/DOM 引用
grep browser/ → "browser is mycli-clean"   # 零 mycli-web 引用
```

## 已知问题

1. **无内置工具标记 requiresApproval**：per spec，`requiresApproval: true` 由消费方按业务需求设置。当前所有内置工具均未标记，审批弹窗不会自动触发。
2. **规则管理 UI 未实现**：`rules.ts` 的 allow/deny/ask 规则目前只能通过代码设置，规则管理界面是独立的后续 spec，未包含在本分支。
3. **Abort 中途未 live 测试**：`AbortSignal` 在 abort 时会取消 pending 审批请求，逻辑由单测覆盖，但尚未通过 Chrome 扩展进行真机 live 验证。
4. **条件展开模式重复 4 处**：`...(x !== undefined ? { x } : {})` 模式在字段链路中出现 4 次（approval.ts + agentService + agentClient 等），属于当前规模的惯用写法，已在 prompt-cache 分支交接备忘中说明，暂不抽提函数。

## 下一步

Brainstorming 规划了 5 个子项目，本分支（User Approval Flow）对应 #2。其余 3 个还在 pending，每个开始前需要跑 `superpowers:brainstorming`：

3. **Plan + TodoWrite** — 在 agent 规划阶段生成可审批的执行计划，用户逐步批准各步骤。需要 `ApprovalAdapter` + `PlanExecutor` kernel 扩展 + 新 wire 事件。
4. **Sub-agent / Fork** — 多 agent fork 时，子 agent 的危险工具调用冒泡到父 agent 的审批流。需要 agentService fork API + coordinator 层级代理。
5. **多 Tab 编排** — 多 tab 并发运行时，统一的审批队列跨 tab 聚合，避免多弹窗干扰。涉及 service worker broadcast + shared approval queue registry。

三个原则不变：kernel-first（先扩 API，再做壳）、不改 consumer 仅加壳、每个 task 对应一个 TDD commit。
