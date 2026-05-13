# Sub-agent / Fork — Handoff

**Date:** 2026-05-13
**Sub-project:** #4 of mycli-web roadmap
**Spec:** `docs/superpowers/specs/2026-05-13-subagent-fork-design.md`
**Plan:** `docs/superpowers/plans/2026-05-13-subagent-fork.md`
**Branch:** `worktree-feat-subagent-fork`(基于 main `6baface`)

## 已交付

### kernel(`packages/agent-kernel/`)

- `core/subagent/SubagentType.ts` — `SubagentType` 接口 + `buildSubagentTypeRegistry`(name 格式校验 + 重名抛错)
- `core/subagent/Subagent.ts` — `Subagent` 运行器(复用 `QueryEngine`)+ `SubagentFailedError`(3 个 code)
- `core/subagent/taskTool.ts` — `buildTaskTool(registry, llm)` 工厂(动态 description / 入参 enum)
- `core/subagent/index.ts` + `core/index.ts` + `src/index.ts` — re-exports
- `core/types.ts` — `ToolExecContext` 新增 `turnId / callId / subagentId / emitSubagentEvent`;新增 `SubagentId / SubagentEventInput`
- `core/AgentSession.ts` — executeTool 闭包填 `callId: call.id`
- `core/ToolRegistry.ts` — 构造函数加可选 `ReadonlyArray<ToolDefinition>` 参数(back-compat)
- `core/protocol.ts` — 5 个 `subagent/*` AgentEvent 变体(core)
- `browser/rpc/protocol.ts` — 5 个 `subagent/*` 变体(wire,用 Base.extend 风格)
- `browser/agentService.ts` — 每 turn 构造 OpenAICompatibleClient 一次,与 `buildTaskTool` 共享;`fullCtx.__taskParentRegistry` 后门暴露父 registry;新增 `subagentTypeRegistry?` 到 `AgentServiceDeps`
- `browser/bootKernelOffscreen.ts` — 新增 `subagentTypes?: readonly SubagentType[]` 选项,非空时构造 registry 并透传

### consumer(`packages/mycli-web/`)

- `src/extension-tools/subagentTypes/generalPurpose.ts` — reference 类型(7 allowedTools,maxIterations=15)
- `src/extension-tools/subagentTypes/index.ts` — `allSubagentTypes` 聚合
- `src/extension/offscreen.ts` — 把 `allSubagentTypes` 传给 `bootKernelOffscreen`
- `src/extension/ui/SubagentCard.tsx` — 可展开的子 agent 卡片(running/finished/failed/aborted 状态 + status glyph + finalText preview)
- `src/extension/content/ChatApp.tsx` — 订阅 5 个 `subagent/*` 事件,维护 `subagents` 和 `callIdToSubagentId` 两张 map,resetTurnState 清理
- `src/extension/ui/ChatWindow.tsx` — 透传 props
- `src/extension/ui/MessageList.tsx` — `tool === 'Task'` 时路由到 `<SubagentCard>`,否则 fallback `<ToolCallCard>`
- `tests/extension-tools/subagentTypes.test.ts` — 静态守护(allowedTools 名字校验、name 格式)

## 验证

- kernel 测试:306 → **347**(+41)
- consumer 测试:51 → **53**(+2)
- workspace typecheck:clean
- consumer build:clean

### Portability 守护

```
core/subagent has chrome.*?           OK
core/subagent has mycli/@ext?          OK
consumer deep-imports kernel src/?     OK
```

预先存在的 `mycli-web` string 字面值(2 处,不是本次引入):
- `core/truncate.ts:20` — truncation marker 文案
- `browser/agentService.ts:178, 185` — console.log 前缀

这些是 cosmetic 字符串,不影响功能。可作 follow-up 抽出为可配置常量。

## 关键设计决策回顾

| # | 决策 |
|---|---|
| 1 | Task tool 同步阻塞;并发靠 LLM parallel-tool-calls 天然支持 |
| 2 | subagent 类型 consumer 注册,kernel 零内置 |
| 3 | 禁递归 — child registry 无条件 filter Task tool |
| 4 | UI 全透明 — 5 个 `subagent/*` 事件流到 Shadow-DOM 卡片 |
| 5 | 子 agent 用 subagentId 作 conversationId,TodoWrite 隔离;approval/settings 共享 |
| 6 | `bootKernelOffscreen({ subagentTypes })` 启动注入;空数组等同不传 |
| 7 | 中间消息 ephemeral;事件 schema 带 subagentId/parentCallId/parentTurnId 留给 consumer 自接 |
| 8 | maxConcurrent 字段位预留,v1 不读 |

## v1 偏差 / 已知 follow-up

### 已声明的 spec 偏差

- **`subagent/message` 用 `text: string`** 而不是设计稿 §4.1 的 `content: ContentBlock[]` — 对齐 `assistant/iter` 模式。后续要扩 block 数组只需加 `content?: ContentPart[]` 字段,不破坏 wire schema。

### Final review 提出的 follow-up(deferred)

**Important**:
- **缺端到端集成测试**:`agentService.runTurn → Task tool execute → Subagent.run → emit → wire` 全链路没有专门测试。Subagent / taskTool / agentService 各自独立单测覆盖,但拼装路径无回归保护。建议下一次给 `tests/browser/agentService.subagent.test.ts` 补一个脚本化 LLM 派一次 Task 的端到端断言,检查事件顺序 `tool/start(Task) → subagent/started → subagent/finished → tool/end(Task)`。
- **`subagent/message.ts` 字段被覆写**:`emitSubagentEvent` 的 `{ ...ev, ts: Date.now() }` 用 spread 顺序使得内部 `ts` 被 envelope `ts` 取代。当前行为合理(wire `ts` = emit 时间),但需要一行 comment 防止未来重排 spread 顺序时改变语义。

**Minor / 完全可延后**:
- `__taskParentRegistry` 后门可改成正式 `parentRegistry?: ToolRegistry` 字段(去掉 1 个 `as any`)
- `Subagent.ts:82` `id as unknown as string as any` 三重 cast — `ConversationId` 可放宽接受 `SubagentId`,或加 comment 说明
- `SubagentEventInput` 的 `[k: string]: unknown` 注释里加一句"full validated shape in core/protocol.ts"
- `RpcClient.on` 类型不识别新 wire 变体,导致 ChatApp 用 5 处 `as any` — kernel 改进 RpcClient 泛型
- `SubagentCard.tsx` messages 用 `key={i}` — append-only 安全,但若以后支持编辑就要换成稳定 id
- `SubagentType.allowedTools` 不校验内容(空字符串、重名、`Task` 在里面);现在仅在 Subagent.run 时过滤 — 可在 `buildSubagentTypeRegistry` 加一道
- 把 `[mycli-web/...]` 字符串前缀和 truncation marker 抽成 boot 时可配置常量,让 kernel 字面 portable

### 没做的非目标(再次声明 spec §1)

- 递归 spawn(明确 filter Task tool)
- 中间消息 IDB 持久化
- wall-clock timeout
- 跨 SW 重启续跑
- 子 agent 独立 LLM provider
- 子 agent 内 skills
- 自定义 subagent type UI
- `maxConcurrent` 强制执行

## 下一步建议

1. **手测**:让主 agent 派 1 个 `general-purpose` 子 agent 做真实查询(e.g."调研当前页面里的 3 个外链,汇总信息"),验证:
   - Task tool 在主对话中触发
   - SubagentCard 实时刷新
   - 子 agent 内 tool call 不打主对话的 todos
   - 取消主 turn 同步取消子 agent
2. **补端到端集成测试**(important follow-up)
3. 评估第 2 个 subagent type 的实际需要(`explore`、`code-search` 等)

## Commit 列表

```
eb6d29f feat(consumer): SubagentCard UI + ChatApp subscription + Task call routing
a4859cb feat(consumer): general-purpose subagent type + offscreen wiring
2f835ff feat(kernel): bootKernelOffscreen wires subagentTypes + Task tool per turn
e249bc7 feat(kernel): wire AgentEvent gains 5 subagent/* variants
f75fefa feat(kernel): Task tool factory + subagent module re-exports
d3bafe9 feat(kernel): Subagent runner + SubagentFailedError
292d25d feat(kernel): AgentEvent gains 5 subagent/* variants
a566ff2 feat(kernel): SubagentType interface + buildSubagentTypeRegistry
40e1796 fix(kernel): use SubagentEventInput for emitSubagentEvent param
a3b7179 feat(kernel): ToolExecContext gains turnId/callId/subagentId/emitSubagentEvent
```

加上本 handoff doc:11 commits total。
