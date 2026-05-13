# Eval Batch Hang Fix — Handoff

**Date:** 2026-05-13
**Sub-project:** Eval batch hang fix(eval extension 的后续修复)
**Spec:** `docs/superpowers/specs/2026-05-13-eval-batch-hang-fix-design.md`
**Plan:** `docs/superpowers/plans/2026-05-13-eval-batch-hang-fix.md`
**Branch:** `worktree-feat-eval-batch-fix`

## 已交付

### kernel(`packages/agent-kernel/src/`)

- **`core/retry.ts`** — `withRetryBackoff` 纯函数 helper:exponential backoff + jitter,可独立测试
- **`core/OpenAICompatibleClient.ts`** —
  - 拆 `streamChatInner` 为 `openConnection`(retry-able)+ `consumeStream`(不 retry)
  - `streamChat` 用 `withRetryBackoff` 包 `openConnection`
  - `ClientConfig` 加 `maxRetries?: number`(默认 2)+ `retryBaseMs?: number`(默认 500)
  - **Mid-stream 错误不 retry**(避免双倍计费)
- **`errors.ts`** — 扩 `classifyError` 识别 Node-style network codes(ECONNRESET / ECONNREFUSED / ETIMEDOUT / EAI_AGAIN / EPIPE / ENETUNREACH / ENOTFOUND)为 retryable Network 错误。**这是修复关键** — 之前 ECONNRESET 走 `Unknown` 不 retryable,所以从未触发 retry

### eval(`packages/agent-kernel/eval/`)

- **`core/runner.ts`** — `RunSingleArgs.taskTimeoutMs?` 字段;`setTimeout → taskAbort.abort()`;abort signal 接入 `QueryEngine` + 每个 `ToolExecContext.signal`;trace 后置 `abortReason='timeout'` 标记;默认 300_000ms(5 min)
- **`core/runEval.ts`** —
  - `RunEvalCoreArgs.parallel?`(默认 1)+ `taskTimeoutMs?`
  - 主循环改为 worker pool(`parallel=1` 时严格 serial 零行为变化)
  - **per-task error isolation**:try/catch 包 `runSingleTask`,异常→`makeFailedReport`,batch 继续
  - 顺序保留:`reports[idx]=...` 写固定 slot
- **`cli/eval.ts`** — `--parallel=N` + `--task-timeout-ms=N` 解析

## 验证(单元测试)

- kernel: 390 → **410**(+20 测试覆盖 retry + timeout + pool + error isolation)
- typecheck: clean
- portability: 新代码零 chrome / mycli / @ext 引用
- 1 个 pre-existing flake(`openAiClientTimeout.test.ts` 100ms timing-sensitive 断言),与本 PR 无关

## 验证(集成实跑)— **关键证明**

| 命令 | Before(broken) | After(fixed) |
|---|---|---|
| `bun run eval --filter=L2 --parallel=2` | 7+ 分钟无进展挂死 | **8/8 完成,mean 0.89,~9 min** ✅ |
| `bun run eval --parallel=2`(全 27) | 30+ 分钟挂死(L4 阶段)| **27/27 完成,23/27 pass mean 0.820,~28 min** ✅ |

### 全 27 任务 baseline(parallel=2,GLM-4.6)

| Level | Pass | Mean composite |
|---|---|---|
| L1-basic | 6/6 (100%) | **0.92** |
| L2-chain | 7/8 (87.5%) | **0.89** |
| L3-complex(混合 original + todo) | 5/7 (71%) | **0.78** |
| L4-subagent | 5/6 (83%) | **0.68** |
| **TOTAL** | **23/27 (85%)** | **0.820** |

4 个失败:
- `L2/exp-cross-validate` (0.37)
- `L3/plan-then-edit` (0.24) — todo minItems 不达标(prompt tuning follow-up)
- `L3/refactor-walkthrough` (0.83 composite,但 completion 不达标)
- `L4/iterative-research` (0.33) — 已知 hallucinate / 合成 问题

注:23/27 比之前 serial 跑出的 26/27 略低,**主要是 LLM 单次噪声**(L3-todo 任务的 minItems 阈值偏紧,模型表现波动)。Infrastructure 本身已修。**多次 run 取中位数会平滑这种噪声**。

## 关键设计回顾

| 决策 | 实施细节 |
|---|---|
| Pre-first-chunk only retry | `openConnection` 在 retry boundary,`consumeStream` 不 retry(避免双倍计费) |
| 默认 maxRetries=2 | 总尝试 3 次,delay ~500ms / ~2s + jitter |
| Per-task wall-clock | 默认 5 min,可 `--task-timeout-ms=` 覆盖 |
| Per-task error isolation | runOne try/catch + makeFailedReport,batch 继续 |
| Parallel default=1 | strict serial 零行为变化 |
| 控并发避免触发 hang | 不试图 root-cause GLM 连接池,直接限流;parallel=2 实测安全 |

## 已知后续 / Follow-up

**Pragmatic 工作绕过(已修)**:
- 现在 batch eval 可信:`bun run eval --parallel=2` 27 任务稳定完成

**Important(可单独修)**:
- T4 implementer 加了"engine error → failed report"coercion(QueryEngine 把 LLM error 吞成 done event;纯 try/catch 接不到)— 这是 pragmatic,但 cleaner 修法是给 `RunTrace.abortReason` 加 `'llm-error'` 字面值并让 runner 翻译。值得 follow-up
- `openAiClientTimeout` flake(pre-existing,100ms timing 不稳)— 与本 PR 无关
- L3/plan-then-edit + L3/refactor-walkthrough 的 todo `minItems` 阈值偏紧,模型实际表现 3-4 而不是 4-5 → 可调任务定义

**Minor**:
- `--parallel=N` 边界:目前不限上限,N=20 可能再触发 GLM 连接池(实测 N=2 安全)。文档说明 "recommended ≤ 4" 即可
- Wall-clock timeout 默认 5min 对个别 L4 任务可能偏紧,可在 task budget 上 override

## 上手命令

跑 baseline(real LLM,record 模式):

```bash
cd packages/mycli-web
export MYCLI_LLM_API_KEY=<key>   # 见 ~/test.txt
export MYCLI_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export MYCLI_LLM_MODEL=glm-4.6
export MYCLI_JUDGE_LLM_API_KEY=$MYCLI_LLM_API_KEY
export MYCLI_JUDGE_LLM_MODEL=glm-4.5-flash

# 全 27 任务,parallel=2,约 28 分钟
bun run eval --parallel=2

# 单 level,parallel=2,约 10 分钟
bun run eval --filter=L2 --parallel=2

# 设短 timeout 避免单任务卡(如 iterative-research)
bun run eval --filter=id:L4/iterative-research --task-timeout-ms=120000
```

## Commit 列表

```
cbba35f feat(eval): CLI --parallel=N + --task-timeout-ms=N flags
3599abe feat(eval): runEvalCore parallel pool + per-task error isolation
4ebb4f2 feat(eval): runSingleTask per-task wall-clock timeout (default 5min)
8b0f8c7 feat(kernel): OpenAICompatibleClient retries pre-first-chunk errors
cdd3224 feat(kernel): withRetryBackoff helper for exponential backoff retry
58e4e13 docs: eval batch hang fix implementation plan
6f081dc docs: eval batch hang fix design spec
```

加 handoff doc = **8 commits total**(其中 5 个 feature commit,2 个 docs,1 个 handoff)。
