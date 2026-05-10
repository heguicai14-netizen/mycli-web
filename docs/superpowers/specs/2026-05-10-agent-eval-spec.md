# Agent Kernel 评测规范（Eval Spec）

- **状态**：Approved（待 plan）
- **日期**：2026-05-10
- **范围**：`packages/agent-kernel/eval/` —— 一套面向 kernel 自身的 agent 能力评测体系，任何 kernel 消费方可直接复用
- **目标用户**：kernel 维护者；kernel 消费方（当前 `mycli-web`，未来其它扩展）

---

## 0. 设计目标 / 非目标

**目标**

1. 用一套可重复的协议评估 agent 在 kernel 上的能力——不是单测、不是集成测，而是端到端的"任务完成度 + 中间链路 + 复杂任务"质量评测
2. **kernel 中立**：harness 不绑定具体扩展；任何消费方换上自己的 LLM 配置即可跑出可比对的分数
3. **CI 友好**：smoke 套件能在 <60s 离线（回放）跑完，作为防回归门
4. **可扩展**：消费方能往 builtin suite 里加自己业务相关的 task；新工具可以注册新的 fake 实现

**非目标**

- 不替代单元测试 / 集成测试（那些继续走 vitest）
- 不评估 LLM 本身的通用能力（那是 model card / 公开榜单的事）
- 不做真实浏览器 E2E（不起 headless Chrome；那是另一套）
- 不做安全 / 红队评测（独立话题，未来另起 spec）

---

## 1. 目录与文件结构

新增 `packages/agent-kernel/eval/`，与 `tests/` 平级：

```
packages/agent-kernel/
├── src/
├── tests/
└── eval/
    ├── README.md                      # 顶层导览
    ├── package.json                   # 仅声明 sub-path 导出（不发布）
    ├── tsconfig.json                  # composite，refs kernel src
    │
    ├── core/                          # harness 引擎
    │   ├── runner.ts                  # runEval(suite, opts) 入口
    │   ├── types.ts                   # TaskPack / Task / Judge / Trace / Report 接口
    │   ├── trace.ts                   # 从 QueryEngine 钩出 trace 的 collector
    │   ├── scorer.ts                  # 维度打分、聚合
    │   └── reporter/
    │       ├── markdown.ts
    │       ├── json.ts
    │       └── console.ts
    │
    ├── fixtures/                      # 参考工具集 + 页面快照
    │   ├── tools/
    │   │   ├── fakeReadPage.ts
    │   │   ├── fakeReadSelection.ts
    │   │   ├── fakeQuerySelector.ts
    │   │   ├── fakeListTabs.ts
    │   │   ├── fakeScreenshot.ts
    │   │   ├── fakeFetch.ts
    │   │   └── fakeUseSkill.ts
    │   └── snapshots/
    │       ├── INDEX.md               # 由 snapshot 文件顶部注释生成
    │       ├── github-issue-1234.html
    │       ├── exp-dashboard-12345.html
    │       ├── ...
    │       └── multi-tab-context/{tab-a.html, tab-b.html}
    │
    ├── judges/
    │   ├── hard.ts                    # regex / contains / json-path / state-equals
    │   ├── trace-shape.ts             # tool-called / order / max-redundant / recovery
    │   └── llm-judge.ts               # 调消费方传入的 judgeLLM，结构化打分
    │
    ├── tasks/                         # 首批 18 个任务
    │   ├── L1-basic/                  # easy：单步 / 单工具
    │   ├── L2-chain/                  # medium：2-4 步 / 多工具
    │   ├── L3-complex/                # hard：分解 / 跨 tab / 多 skill
    │   └── index.ts                   # 导出 builtinSuite
    │
    └── cli/
        └── eval.ts                    # bun run eval 入口
```

消费方接入（约 10 行 `eval-config.ts`）：

```ts
// packages/mycli-web/eval-config.ts
import { runEval, builtinSuite } from "agent-kernel/eval"

export default {
  llm:      { model: "glm-4.6", apiKey: process.env.LLM_KEY!, baseUrl: "..." },
  judgeLLM: { model: "glm-4.5-flash", apiKey: process.env.JUDGE_KEY!, baseUrl: "..." },
  suite:    builtinSuite,        // 或 [...builtinSuite, ...customTasks]
  reporter: ["console", "markdown", "json"],
  outDir:   "./eval-out",
}
```

---

## 2. 核心抽象（接口）

### 2.1 任务定义

```ts
// eval/core/types.ts

export interface Task {
  id: string                      // "L2-chain/exp-treatment-readout"
  level: "L1" | "L2" | "L3"
  prompt: string                  // 用户对 agent 说的话
  fixtures: {
    snapshot?: string             // snapshot 文件名
    tabs?: string[]               // 多 tab 场景
    fetchMap?: Record<string, FetchFixture>
    skills?: Record<string, string>  // skill name → body
  }
  judge: JudgeSpec                // 该任务的判分组合
  budget: TaskBudget              // 上限：步数 / token / 时长
  passThreshold?: number          // 默认按 level 取（L1=0.7 / L2=0.6 / L3=0.5）
  tags?: string[]
}

export interface TaskBudget {
  expectedSteps: number
  expectedTokens: number
  expectedDurMs: number
  maxSteps: number                // 硬上限，超过即 abort
}

export type FetchFixture =
  | string                        // 直接返回体
  | { body: string; failOnce?: boolean }
```

### 2.2 判分规约

```ts
export interface JudgeSpec {
  completion?: HardAssertion[]    // 通过条数 / 总条数 计入 completion 分量
  trace?: TraceAssertion[]        // 工具链路检查
  llm?: LlmRubric                 // 主观项才用，可选
}

export type HardAssertion =
  | { kind: "answer-contains"; value: string | RegExp }
  | { kind: "answer-equals"; value: string }
  | { kind: "answer-json-path"; path: string; equals: unknown }
  | { kind: "state-equals"; key: string; value: unknown }

export type TraceAssertion =
  | { kind: "tool-called"; name: string; argsMatch?: object }
  | { kind: "tool-not-called"; name: string }
  | { kind: "tool-order"; sequence: string[]; strict?: boolean }
  | { kind: "max-redundant-calls"; name: string; max: number }

export interface LlmRubric {
  question: string
  scale: "pass-fail" | "0-5"
  weight?: number                 // 默认 1
}
```

### 2.3 执行选项

```ts
export interface RunOptions {
  llm: LlmConfig
  judgeLLM?: LlmConfig
  filter?: { levels?: Task["level"][]; tags?: string[]; ids?: string[] }
  parallel?: number               // 默认 1
  recordTo?: string               // 录制 fixture
  replayFrom?: string             // 回放 fixture
  reporter: ReporterId[]
  outDir: string
}
```

### 2.4 Trace（被动采集，由 runner 钩到 QueryEngine）

```ts
export interface RunTrace {
  taskId: string
  steps: TraceStep[]
  finalAnswer: string
  tokensIn: number
  tokensOut: number
  durationMs: number
  abortReason?: "max-iter" | "budget-tokens" | "timeout" | "consumer"
}

export type TraceStep =
  | { kind: "assistant-message"; text: string }
  | { kind: "tool-call"; name: string; args: unknown; id: string }
  | { kind: "tool-result"; id: string; ok: boolean; data?: unknown; error?: string }
```

### 2.5 报告

```ts
export interface TaskReport {
  task: Task
  trace: RunTrace
  scores: {
    completion: number            // 0..1
    traceQuality: number          // 0..1
    efficiency: number            // 0..1
    composite: number             // 加权后总分
  }
  passed: boolean
  failures: string[]
}

export interface SuiteReport {
  schemaVersion: 1
  startedAt: string
  llmModel: string
  totals: { passed: number; failed: number; skipped: number }
  byLevel: Record<"L1" | "L2" | "L3", { passed: number; failed: number; meanComposite: number }>
  byTag: Record<string, { passed: number; failed: number; meanComposite: number }>
  meanComposite: number
  meanTokens: number
  meanSteps: number
  tasks: TaskReport[]
}
```

**设计要点**

- Task 是数据，不是函数——可序列化、回放、跨语言
- Judge 是组合式：硬断言永远先跑；LLM 仅作为补充项加权
- Trace 是被动采集：runner 在 `QueryEngine` 上注册观察 hook，不侵入业务
- `fixtures` 让 task 跟 snapshot 显式绑定，避免 task 文件自己藏数据

---

## 3. 判分协议

### 3.1 单 task 三维分数

```
completion  = (硬断言通过条数 / 硬断言总条数) * (1 - λ_llm) + LLM分 * λ_llm
              # 没有 LLM rubric 时 λ_llm = 0
              # 有 LLM rubric 时   λ_llm = clamp01(0.3 * rubric.weight)
              #   weight=1   → λ_llm=0.30   （默认）
              #   weight=1.5 → λ_llm=0.45
              #   weight=2   → λ_llm=0.60

traceQuality = (1) tool-called / not-called / order 命中率   * 0.6
             + (2) 1 - min(1, redundantCalls / maxAllowed)   * 0.2
             + (3) recoveryScore                              * 0.2
                    # rubric: 工具 error 后是否换思路而非死磕
                    # 该 task 无工具失败时该子项满分

efficiency   = stepScore * 0.5 + tokenScore * 0.4 + latencyScore * 0.1
   stepScore   = clamp01(1 - (steps  - budget.expectedSteps)  / budget.expectedSteps)
   tokenScore  = clamp01(1 - (tokens - budget.expectedTokens) / budget.expectedTokens)
   latencyScore= clamp01(1 - (durMs  - budget.expectedDurMs)  / budget.expectedDurMs)
                  # 三个都是"超出预算线性扣分，不超不加"

composite = completion * 0.55 + traceQuality * 0.30 + efficiency * 0.15

passed    = composite >= task.passThreshold
         && completion >= 0.5    # 硬卡：哪怕 trace/efficiency 满分，结果错就是失败
```

### 3.2 traceQuality 内部分量

| 子项 | 权重 | 计算 |
|---|---|---|
| 工具选择正确 | 0.35 | `tool-called` / `tool-not-called` 断言命中率 |
| 工具调用顺序 | 0.15 | `tool-order` 断言。strict=true 时严格匹配；false 时只要出现且相对顺序对 |
| 参数正确 | 0.10 | `tool-called` 的 `argsMatch` 子断言（结构子集匹配） |
| 无冗余 | 0.20 | `1 - min(1, redundantCalls / max)`；同 `(name, normalize(args))` 出现 >1 次记一次冗余 |
| 错误恢复 | 0.20 | 出现过 `tool-result.ok=false` 时：之后是否换 tool 或换参数；是→满分；继续重试同样的→0；放弃→0.5 |

### 3.3 判分流程

```
1. 跑 task → 得到 RunTrace
2. 跑硬断言（completion + trace）→ 通过/失败 & 命中率
3. 如果 task 有 LLM rubric:
     调 judgeLLM → 0..1 标量
4. 算 efficiency 三分量
5. 加权得 composite + passed
6. 收集 failures: 列出每条挂了的断言（带实际值/期望值）
```

### 3.4 LLM-as-judge prompt 模板

```
你是 agent 评测官。下面是 agent 任务、用户提问、agent 最终答案、完整工具调用 trace。
请按 rubric 打分。只输出 JSON：{"score": <数字>, "reason": "..."}

[Rubric] {{rubric.question}}
[Scale]  {{rubric.scale}}    // pass-fail → score ∈ {0,5}
[Task]   {{task.prompt}}
[Answer] {{trace.finalAnswer}}
[Trace]  {{traceCompact}}    // 只保留 tool name + 关键参数 + ok/error，省 token
```

判分调用走 `judgeLLM` 配置（与 `llm` 隔离），用便宜 model（如 GLM-4.5-flash 或 gpt-4o-mini）。`scale` 归一到 0..1 后混入 completion。

### 3.5 汇总分数

```
meanComposite   = mean(tasks.composite)        # 主指标
passRate        = passed / total               # 副指标
byLevel.passRate                               # 区分 L1/L2/L3 看能力曲线
regressionDelta = thisRun.meanComposite - baseline.meanComposite
                  # CI smoke 阈值：< -0.05 → 失败
```

权重（55/30/15、子项权重、CI 回归阈值 -0.05）写死在 `scorer.ts`，task 可 override。

---

## 4. Trace 采集与"中间链路"度量

### 4.1 采集机制

`QueryEngine` 暴露一个观察接口 `engine.on(event, handler)`，eval harness 通过它收集 trace。**这是规范要求 kernel 新增的唯一一处接口**——不改业务语义。

```ts
// eval/core/trace.ts
export function instrumentEngine(engine: QueryEngine, collector: RunTrace): () => void {
  const offMsg  = engine.on("assistant_message", (text)  => { collector.steps.push({ kind: "assistant-message", text }) })
  const offCall = engine.on("tool_call",         ({ id, name, args })           => { collector.steps.push({ kind: "tool-call", id, name, args }) })
  const offRes  = engine.on("tool_result",       ({ id, ok, data, error })      => { collector.steps.push({ kind: "tool-result", id, ok, data, error }) })
  const offTok  = engine.on("usage",             ({ in: i, out: o })            => { collector.tokensIn += i; collector.tokensOut += o })
  return () => { offMsg(); offCall(); offRes(); offTok() }
}
```

### 4.2 几条非显然的设计取舍

- `assistant_message` 入 trace 让 LLM-as-judge 看到思考转折，但**不参与硬断言**——否则会鼓励"话术匹配"而非真行为
- 冗余检测用 `(name, normalize(args))`；`normalize` 去 whitespace、排序 object key、忽略 `signal` / `abort` 字段
- 错误恢复评分**只在该 task 至少出现 1 次工具失败时启用**；否则该子项满分（不扣不加）
- Token 统计走 LLM 客户端的 `usage` 事件；fakeLLM（回放模式）按 fixture 里写好的数填回，保证回归可对账

### 4.3 失败 task 在报告里的样子

```
Task: L2-chain/extract-issue-title  ❌ composite=0.42
─ Steps (8) ──────────────────────────────────────
  1. assistant: "我先看页面..."
  2. tool-call  readPage()
  3. tool-result ok=true (1.2KB)
  4. tool-call  readPage()                ⚠ 冗余（与 step 2 重复）
  5. tool-result ok=true
  6. tool-call  querySelector(".title")
  7. tool-result ok=true → "Issue #1234: ..."
  8. assistant: "标题是 ..."
─ Failures ───────────────────────────────────────
  ✗ trace.max-redundant-calls(readPage, max=1): actual=2
  ✗ completion.answer-contains("#1234"): actual="Issue: ..."
  ✓ trace.tool-order([readPage, querySelector])
─ Scores ─────────────────────────────────────────
  completion=0.50  traceQuality=0.55  efficiency=0.30  composite=0.49
```

---

## 5. 任务集分级与首批 18 个任务

### 5.1 分级标准

| 级别 | 步数预算 | 工具数 | 特征 | passThreshold |
|---|---|---|---|---|
| **L1 basic** | ≤3 步 | 1 个工具 | 单步取信息、简单总结。考"会不会用工具" | 0.7 |
| **L2 chain** | 4-8 步 | 2-4 个工具 | 串联、条件分支。考"能不能搭链路" | 0.6 |
| **L3 complex** | 9-20 步 | ≥3 个工具 + skill | 跨 tab、分解、多 skill 组合、错误恢复。考"会不会规划与自救" | 0.5 |

### 5.2 首批 18 任务

| 级别 | 数量 | 任务 ID |
|---|---|---|
| L1 basic | 6 | extract-title / extract-selection / list-tabs / get-by-selector / fetch-json / screenshot-describe |
| L2 chain | 8 | issue-summary / cross-tab-compare / fetch-then-extract / conditional-branch / multi-step-extract / fail-then-fallback / **exp-treatment-readout** / **exp-cross-validate** |
| L3 complex | 4 | skill-orchestration / decomposition / recover-and-replan / **exp-go-no-go** |

**加粗**为数据分析 / 多工具联合主题任务。

#### L1 basic 全 6 任务

| id | 提示词 | fixture | 关键断言 |
|---|---|---|---|
| `L1/extract-title` | "这个页面的标题是什么？" | `github-issue-1234.html` | answer-contains("Issue #1234"), tool-called(readPage) |
| `L1/extract-selection` | "总结这段选中的文本" | `selection-paragraph` | tool-called(readSelection), tool-not-called(readPage) |
| `L1/list-tabs` | "我现在打开了哪些 tab？" | tabs=[a,b,c] | tool-called(listTabs), answer 含 3 个标题 |
| `L1/get-by-selector` | "页面上 .price 元素的文本" | `product-page` | tool-called(querySelector,{selector:".price"}) |
| `L1/fetch-json` | "拿这个 url 的 JSON 第一项的 name" | fetchMap | tool-called(fetchGet), answer-json-path |
| `L1/screenshot-describe` | "看下当前页面长啥样" | `landing-page` | tool-called(screenshot)；fakeScreenshot 返固定 caption |

#### L2 chain 全 8 任务

| id | 提示词 | fixture | 关键断言 |
|---|---|---|---|
| `L2/issue-summary` | "总结这个 issue：标题、状态、最近 3 条评论" | `github-issue-1234.html` | tool-order([readPage, querySelector*]), LLM rubric: 三要素覆盖 |
| `L2/cross-tab-compare` | "比较 tab A 和 B 这两篇文章的论点差异" | tabs=[a,b] | tool-called(listTabs), readPage 调 ≥2 ≤2 次（每 tab 各一次），不冗余 |
| `L2/fetch-then-extract` | "从 GitHub API 拿 issue #1234 的 labels，告诉我有几个" | fetchMap | tool-called(fetchGet), answer 含数字 |
| `L2/conditional-branch` | "如果页面有 .error 就告诉我错误内容，否则总结主要内容" | `page-with-error` 与 `page-clean` 跑两次 | querySelector 先于 readPage；error 变体不调 readPage |
| `L2/multi-step-extract` | "把这页所有作者名字列出来" | `blog-list.html` | querySelector(.author) 调 1 次（不是循环 N 次），answer 列表完整 |
| `L2/fail-then-fallback` | "拿 https://broken.example/x 的内容总结" | fetchMap 该 url 返 500 | 错误恢复满分：失败后改用其他工具或明确告知失败而非无限重试 |
| **`L2/exp-treatment-readout`** | "拿 https://exp.internal/api/exp/12345 的实验数据，告诉我 treatment 组相对 control 组哪些指标显著上涨、哪些下跌，最后给我一个是否放量的建议。" | fetchMap = 7 天实验数据（control/treatment/stat_sig） | tool-called(fetchGet, url 匹配 12345)；max-redundant-calls(fetchGet)≤1；answer-contains 命中 ctr/gmv/建议词；LLM rubric "是否正确识别 ctr↑显著、gmv↑显著、cvr 不显著、建议是否合理（应支持放量）"，weight 1.5 |
| **`L2/exp-cross-validate`** | "我打开了一个实验后台 tab，同时这个实验在 API 上也能查。帮我比一下 API 数据和后台页面显示的数据是不是一致，不一致就指出哪条对不上。" | fetchMap 同 12345；snapshot `exp-dashboard-12345.html`（gmv 故意写成 13.50 ≠ API 13.85）；tabs=[dashboard] | tool-called(fetchGet+readPage)；max-redundant-calls 各 ≤1；answer 同时含 13.85 与 13.50；LLM rubric "是否准确指出 gmv 不一致、是否未报假阳性"，weight 1.5 |

#### L3 complex 全 4 任务

| id | 提示词 | fixture | 关键断言 |
|---|---|---|---|
| `L3/skill-orchestration` | "用 summarizePage skill 总结当前页，再把摘要里出现的人名都查一下他们最近在我打开的别的 tab 里出现没" | `article.html` + tabs=[a,b,c] + skills.summarizePage | tool-called(useSkill, summarizePage)、listTabs、readPage 多 tab；LLM rubric 评结果完整性 |
| `L3/decomposition` | "我想了解这个 PR 的影响：列文件、找出 test 文件、对应到测哪些 src 文件" | `pr-page.html` + fetchMap | tool-order [readPage → fetchGet(diff) → 多次 fetchGet(test files)]，max-redundant-calls 限制 |
| `L3/recover-and-replan` | "找 .nonexistent 元素的内容" | `landing-page` | querySelector 调 1 次拿到 error 后不再重复调相同 selector；用 readPage 兜底或明确告知；composite ≥0.5 即通过 |
| **`L3/exp-go-no-go`** | "我准备决定实验 12345 要不要放量。先看一下它本身的数据，再跟最近 3 个同类实验（首页推荐方向）对比，最后给我一个 go / no-go 的结论，要带理由。" | fetchMap：12345 + list?topic=home-rec + 11201 + 11455 + 11890（**11890 故意返 500**，测错误恢复）；tabs=[dashboard] | tool-called(fetchGet) 至少 3 个不同 URL；max-redundant-calls ≤1；遇 500 后不应重试同 URL ≥2 次且继续推进；answer 含 go/no-go 关键词；LLM rubric "结论是否引用当前实验+至少一个历史实验数据；是否如实标注 11890 缺失而非编造；建议是否合理（应倾向 go）"，weight 2 |

### 5.3 任务文件示例

```ts
// eval/tasks/L2-chain/exp-treatment-readout.task.ts
import type { Task } from "../../core/types"

export const task: Task = {
  id: "L2/exp-treatment-readout",
  level: "L2",
  prompt:
    "拿 https://exp.internal/api/exp/12345 的实验数据，告诉我 treatment 组相对 control 组哪些指标显著上涨、哪些下跌，最后给我一个是否放量的建议。",
  fixtures: {
    fetchMap: {
      "https://exp.internal/api/exp/12345": JSON.stringify({
        name: "首页推荐改版 v3",
        duration_days: 7,
        control:   { samples: 102345, ctr: 0.0843, cvr: 0.0231, gmv_per_user: 12.43, stay_sec: 38.2 },
        treatment: { samples: 102881, ctr: 0.0921, cvr: 0.0227, gmv_per_user: 13.85, stay_sec: 41.6 },
        stat_sig:  { ctr: true, cvr: false, gmv_per_user: true, stay_sec: true },
      }),
    },
  },
  budget: { expectedSteps: 4, expectedTokens: 4500, expectedDurMs: 8000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: "answer-contains", value: /ctr|点击/i },
      { kind: "answer-contains", value: /gmv/i },
      { kind: "answer-contains", value: /放量|上线|建议|不建议/ },
    ],
    trace: [
      { kind: "tool-called", name: "fetchGet", argsMatch: { url: /exp\/12345$/ } },
      { kind: "max-redundant-calls", name: "fetchGet", max: 1 },
    ],
    llm: {
      question: "是否正确识别 ctr↑显著、gmv↑显著、cvr 不显著、stay 显著上涨；建议是否合理（应支持放量）？",
      scale: "0-5",
      weight: 1.5,
    },
  },
  tags: ["data-analysis", "chain"],
}
```

---

## 6. 运行模式与报告

### 6.1 两套运行模式

| 模式 | 触发 | 范围 | LLM | 时长 | 用途 |
|---|---|---|---|---|---|
| **smoke** | PR / 每次 push | L1 全 6 + L2 抽 2（固定 id：`L2/issue-summary`、`L2/exp-treatment-readout`） | 回放 fixture 优先；缺则便宜 model | <60s | 防回归。回归 -0.05 → CI fail |
| **full** | 手动 / 每周 cron | 全 18 | 真打目标 model | 5-15 分钟 | 出质量报告、比对 model |

### 6.2 录制 / 回放（让 smoke 能离线跑）

```ts
// 录制：跑一次真 LLM，把每步 LLM 响应序列化到 fixture
runEval({ ..., recordTo: "eval/fixtures/replay/2026-05-10-glm-4.6/" })

// 回放：CI 里跑，不连网，结果稳定
runEval({ ..., replayFrom: "eval/fixtures/replay/2026-05-10-glm-4.6/" })
```

回放 fixture 按 `(taskId, stepIndex, requestHash)` 索引；request hash 不一致即报错（说明 prompt 流变了，需要重录）。每次重录文件名带 `model + 日期`，旧的留作历史对照。

### 6.3 调用入口

```bash
# 全跑（消费方目录里）
bun run eval                         # 默认 reporter=console+markdown，写 ./eval-out/
bun run eval --filter=L2             # 只跑 L2
bun run eval --filter=tag:data-analysis
bun run eval --filter=id:L3/exp-go-no-go
bun run eval --record                # 录回放 fixture

# CI smoke
bun run eval:smoke                   # 内部即 --filter=smoke --replay-from=...
```

`bun run eval` 等于跑消费方仓库里的 `eval-config.ts`。这个配置文件决定 LLM、judgeLLM、suite 组合，CLI 只接收过滤 / 输出选项。

### 6.4 CI 集成（GitHub Actions 示意）

```yaml
# .github/workflows/eval-smoke.yml
- run: bun install
- run: bun run typecheck
- run: bun --cwd packages/agent-kernel test
- run: bun --cwd packages/mycli-web test
- run: bun --cwd packages/mycli-web run eval:smoke
- name: Compare vs baseline
  run: bun run eval:check-regression --baseline=main --threshold=-0.05
```

baseline 文件 `eval/baseline.json` 跟代码一起提交；每次 main 的 full 跑后人工更新 baseline。

### 6.5 三种 reporter

#### console（开发循环）

```
agent-kernel eval • model=glm-4.6 • 18 tasks
─────────────────────────────────────────────
L1  ████████████  6/6   pass=100%  mean=0.91
L2  ██████████░░  6/8   pass= 75%  mean=0.71
L3  ██░░░░░░░░░░  1/4   pass= 25%  mean=0.48
─────────────────────────────────────────────
TOTAL          13/18   pass= 72%  mean=0.74

By tag:
  data-analysis    2/3  mean=0.61   ← 弱项
  multi-tool       3/3  mean=0.78
  recovery         1/2  mean=0.55

Failures:
  ✗ L2/exp-cross-validate    composite=0.51
  ✗ L3/exp-go-no-go          composite=0.42
  ✗ L3/decomposition         composite=0.49

Tokens 142k in / 38k out   |   $0.21   |   8m13s
```

#### markdown（写到 `eval-out/<timestamp>.md`，归档 + 人读）

- 顶部同 console 概览
- 每个 task 一节：prompt / final answer / scores / failures / 完整 trace（带 ⚠ 标记冗余 / 错误恢复点）
- 末尾："与上次 full 跑对比"表（哪些 task 从 pass→fail / fail→pass）

#### json（机器读）

```json
{
  "schemaVersion": 1,
  "startedAt": "...",
  "model": "glm-4.6",
  "totals": { "passed": 13, "failed": 5 },
  "meanComposite": 0.74,
  "byLevel":  { "...": "..." },
  "byTag":    { "...": "..." },
  "tasks":    []
}
```

### 6.6 输出目录约定

```
eval-out/
├── 2026-05-10T14-32-glm-4.6-full/
│   ├── report.md
│   ├── report.json
│   └── traces/                 # 每个 task 一个 trace.json，便于后续 replay 调试
└── latest -> 2026-05-10T14-32-glm-4.6-full
```

`eval-out/` 进 `.gitignore`，只有 `eval/baseline.json` 进 git。

---

## 7. 参考工具集与页面快照

### 7.1 为什么 fake

跨消费方可比 + CI 离线 + 快。每个 fake 工具实现 kernel 的 `ToolDefinition` 接口，行为由 task 的 `fixtures` 字段驱动。

```ts
// eval/fixtures/tools/fakeReadPage.ts
export function makeFakeReadPage(ctx: FixtureCtx): ToolDefinition {
  return {
    name: "readPage",
    description: "Read the current page content (text + structure).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    exec: "offscreen",
    async run(_args) {
      const html = ctx.loadSnapshot(ctx.activeTabSnapshot ?? ctx.task.fixtures.snapshot)
      if (!html) return { ok: false, error: "no snapshot bound" }
      return { ok: true, data: { url: ctx.activeTabUrl, text: htmlToText(html) } }
    },
  }
}
```

`FixtureCtx` 是每个 task 一个，包含：

- `task` / `activeTabUrl` / `activeTabSnapshot` / `tabs[]`
- `loadSnapshot(name)` —— 从 `eval/fixtures/snapshots/` 同步读
- `state` —— 给 fake 工具记录副作用（用于 `state-equals` 硬断言）

### 7.2 全 7 个 fake 工具

| Fake | 行为 | 数据源 |
|---|---|---|
| `fakeReadPage` | 读 active tab 当前 snapshot 的 text | `task.fixtures.snapshot` 或 `tabs[active]` |
| `fakeReadSelection` | 返 snapshot 里 `<!-- SELECTION -->...<!-- /SELECTION -->` 区段 | snapshot 标记 |
| `fakeQuerySelector` | happy-dom 解析 snapshot，返匹配元素 textContent | snapshot |
| `fakeListTabs` | 返 `task.fixtures.tabs` | tabs |
| `fakeScreenshot` | 返固定 caption（snapshot 同名 `.caption.txt`） | `<snapshot>.caption.txt` |
| `fakeFetch` | 查 `task.fixtures.fetchMap[url]`；命中返该值；标 `failOnce` 则首次返 500、第二次起返正常（recovery 任务用） | `fetchMap` |
| `fakeUseSkill` | 查 `task.fixtures.skills[name]` 返 skill body | skills 注入 |

### 7.3 关键设计

- **snapshot 是静态 HTML**——`.html` + 同名可选 `.caption.txt` / `.selection.txt`。不嵌 JS、不执行。`happy-dom` 做 querySelector 解析（vitest 常用，~200KB，可接受）
- **fakeFetch 不发真实网络**——所有 url 必须在 `fetchMap` 里，否则返 `{ ok:false, error:"no fixture for <url>" }`。这把"agent 不该联网时不要联网"也评了
- **`failOnce`** 让 L3 recovery 任务可重复——避免"重试一次就过了"被记成"agent 没恢复"的假阴性
- **`state` 字段**用于未来工具（如 `setStorage`）的副作用断言；当前 18 task 没用到，接口先留
- **fake 工具内禁止 `Math.random` / `Date.now`**——评分必须 deterministic。所有"随机"从 task 内的 seed 派生

### 7.4 snapshot 列表（首批 ~12 个）

`github-issue-1234.html` / `exp-dashboard-12345.html` / `landing-page.html` / `product-page.html` / `blog-list.html` / `pr-page.html` / `article.html` / `selection-paragraph.html` / `page-with-error.html` / `page-clean.html` / `multi-tab-context/{tab-a.html, tab-b.html}`

每个 snapshot 顶部加注释块说明：

```html
<!--
  source: synthetic | trimmed-from: <url> | date: 2026-05-10
  used-by: L1/extract-title, L2/issue-summary
  notes: 删除了所有 <script>，保留 issue 标题/状态/评论 DOM 结构
-->
```

`eval/fixtures/snapshots/INDEX.md` 由顶部注释自动生成。

---

## 8. 对 kernel 的需求改动

落地这套 spec，kernel **只**需要新增一个公开接口：

```ts
// packages/agent-kernel/src/core/QueryEngine.ts
class QueryEngine {
  on(event: "assistant_message", handler: (text: string) => void): () => void
  on(event: "tool_call",         handler: (e: { id: string; name: string; args: unknown }) => void): () => void
  on(event: "tool_result",       handler: (e: { id: string; ok: boolean; data?: unknown; error?: string }) => void): () => void
  on(event: "usage",             handler: (e: { in: number; out: number }) => void): () => void
  // ...
}
```

不改任何业务语义。返回 dispose 函数。事件在原本既有的链路点位发射即可。

---

## 9. 落地范围（写入 implementation plan）

按依赖顺序，分 5 个阶段：

1. **M1 kernel hook** —— 加 `QueryEngine.on(...)`；单测覆盖事件发射时机
2. **M2 harness 骨架** —— `eval/core/{types,runner,trace,scorer,reporter}` + 一个 hello-world task 跑通
3. **M3 fixtures + fake 工具集** —— 7 个 fake 工具 + 12 个 snapshot
4. **M4 18 个 task + judges** —— 全 18 task 文件、3 个 judge 模块、`builtinSuite` 导出
5. **M5 CLI / CI / 报告 / 录回放** —— `eval` / `eval:smoke` / `eval:check-regression`，3 reporter，回放管线，baseline 首次生成

每个 milestone 末尾跑一次 `bun run typecheck` + 两个包的 test，绿了才进下一阶段（与 kernel-extraction plan 同款节奏）。

---

## 10. 显式非目标 / 后续

- **不做 headless 浏览器 E2E**：所有"页面"都是离线 snapshot
- **不做安全 / 红队评测**：未来另起 spec
- **不评 LLM 通用能力**：本 spec 只评 agent 在 kernel 上的表现
- **未来扩展**：tool-mocks 真实化（拿 happy-dom 跑真 querySelector 已经在做）、视觉 task（fakeScreenshot 配 OCR-like fixture）、多轮对话 task（task.prompt 改为 turns[]）

---

**附录 A：术语对照**

| 中文 | 英文 | 备注 |
|---|---|---|
| 任务 | Task | 评测的最小单元 |
| 套件 | Suite / TaskPack | 一组 task |
| 中间链路 | Trace / Tool-call sequence | agent 执行过程的工具调用序列 |
| 判分器 | Judge | 给 task 打分的逻辑 |
| 报告器 | Reporter | 把 SuiteReport 渲染成 console / md / json |
| 回放 | Replay | 用录制的 LLM 响应离线重跑 |
| 基线 | Baseline | 上次 main 跑的 SuiteReport，用于回归比对 |
