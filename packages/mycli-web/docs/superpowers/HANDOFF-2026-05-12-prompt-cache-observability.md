# Prompt Cache Observability 实施交接备忘 — 2026-05-12

## 一句话总结

`cached_tokens` 字段从 OpenAI 兼容协议的 `usage_metadata` 一路传到 wire 协议的 `message/usage` 事件，全链路打通，**所有测试通过**（249 kernel 单测 + 34 consumer 单测），构建干净，live 集成用例 #14 默认 skip，有 API Key 时可验证。

## 跑了什么

5 个 task 通过 subagent-driven-development 流程顺序执行，每个 task 对应一个 commit：

| Task | Commit | 说明 |
|---|---|---|
| T1 | `9cfaea5` | `defaultUsageParser` + `NormalizedUsage` 类型，提取 `cached_tokens` |
| T2 | `d9cd2d7` | client 层通过 `done.usage.cached` 把字段浮到上层 |
| T3 | `a530b39` | `QueryEngine` + `AgentSession` + core protocol Zod 传递 `cached?` |
| T4 | `5e6a627` | wire `MessageUsage` Zod 加 `cached?`，`agentService.runTurn` 转发 |
| T5 | `6920422` | live 集成测试 #14 验证字段链路，默认 skip，无凭据不跑 |

## 如何试一下

### 方法 A — 跑 kernel 单测（无需凭据）

```bash
cd packages/agent-kernel
bun run test
# 预期：249 tests passed
```

字段链路由 `tests/core/defaultUsageParser.test.ts`、`tests/core/openAiClientUsage.test.ts`、`tests/core/queryEngineUsage.test.ts`、`tests/browser/agentService.test.ts` 覆盖（6 + N 个用例）。

### 方法 B — 跑 live 集成测试（需要 API Key）

```bash
MYCLI_TEST_API_KEY=sk-xxx \
MYCLI_TEST_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
MYCLI_TEST_MODEL=glm-4-flash \
cd packages/mycli-web && bun run test:live
# 用例 14 会跑：检查 usage 事件上 cached 字段的类型
```

用例 #14 不断言 `cached > 0`（冷 cache 不一定命中，也不是所有 provider 都上报这个字段）。它只断言：**如果字段存在，必须是非负整数**。provider 不上报的话会打 `console.warn` 然后通过。

### 方法 C — 看 wire 协议

连接 Chrome 扩展后，`message/usage` wire 事件上会带 `cached?: number`。如果 provider 返回了 `prompt_tokens_details.cached_tokens`，这个字段就非零；没返回就是 `undefined`，不会报错。

## 改了哪些文件

### 源文件（kernel）

- `packages/agent-kernel/src/core/OpenAICompatibleClient.ts` — `defaultUsageParser` 解析 `cached_tokens`；`NormalizedUsage` 类型加 `cached?`
- `packages/agent-kernel/src/core/QueryEngine.ts` — 从 client 的 `done.usage` 取 `cached` 并传给 session
- `packages/agent-kernel/src/core/AgentSession.ts` — `usage` 事件加 `cached?` 字段
- `packages/agent-kernel/src/core/protocol.ts` — core `Usage` Zod schema 加 `cached?: z.number().int().nonnegative().optional()`
- `packages/agent-kernel/src/index.ts` — 重新导出新类型
- `packages/agent-kernel/src/browser/agentService.ts` — `runTurn` 转发 `cached`
- `packages/agent-kernel/src/browser/rpc/protocol.ts` — wire `MessageUsage` Zod 加 `cached?`

### 测试文件（kernel）

- `packages/agent-kernel/tests/core/defaultUsageParser.test.ts` — 新增，6 个用例（T1）
- `packages/agent-kernel/tests/core/openAiClientUsage.test.ts` — 新增，client 层 cached 传递（T2）
- `packages/agent-kernel/tests/core/queryEngineUsage.test.ts` — 新增，QueryEngine cached 传递（T3）
- `packages/agent-kernel/tests/browser/agentService.test.ts` — 新增，wire 层 cached 转发（T4）
- `packages/agent-kernel/tests/core/protocol.test.ts` — 更新，补 cached 字段校验（T3）

### 测试文件（consumer）

- `packages/mycli-web/tests/integration/agent.live.test.ts` — 新增用例 #14（T5）

## 已知问题

### 条件展开模式用了 4 处

`...(cached !== undefined ? { cached } : {})` 这个模式在字段链路里出现 4 次（client、QueryEngine、AgentSession、agentService），属于 idiomatic JS 写法，没问题，但看起来重复。可以考虑抽一个 `pickCached(n?: number)` 工具函数，但当前规模不值得。

### Live 测试 #14 无法验证缓存命中率

用例 #14 只验证字段是否**被正确传递**，不断言 `cached > 0`。原因：
1. 冷 cache（第一次请求）不会命中
2. 不同 provider 对 `prompt_tokens_details.cached_tokens` 支持程度不同（GLM-4.6 很可能不上报）

真正的缓存命中率验证需要：两次连续请求 + 相同系统提示 + provider 支持 + 热 cache。留给未来的监控/dashboard 功能。

## 下一步

Brainstorming session 里规划了 5 个子项目，T1-T5 只是 #1（字段链路）。其余 4 个还在 pending，每个开始前需要跑 `superpowers:brainstorming`：

2. **Approval UI** — 在 Chrome 扩展侧边栏显示 cache 命中率 badge/tooltip。需要 ShadowDOM 组件 + wire 事件订阅。
3. **Plan + TodoWrite** — 把 cache 统计写入会话 memory，让 LLM 在 planning 阶段感知到 cache 效率。
4. **Sub-agent / Fork** — 多 agent fork 时共享同一段系统提示前缀，让 cache 命中率最大化。需要 agentService 层的 fork API。
5. **Multi-tab orchestration** — 多 tab 并发时，跨 tab 复用 cache prefix。涉及 service worker broadcast + shared prefix registry。

三个原则不变：kernel-first（先扩 API，再做壳）、不改 consumer 仅加壳、每个 task 对应一个 TDD commit。
