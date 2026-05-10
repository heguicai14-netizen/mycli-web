# Prompt Cache Observability 设计

状态：spec,待实施
日期:2026-05-10

## 概述

让 kernel 的 OpenAI-compatible 客户端在 LLM 响应结束后,把 provider 自动缓存的命中量(`cached_tokens`)读出来,经统一接口透出给 consumer。Consumer 拿到后自由决定是否展示,kernel 不强制 UI。

不引入新 provider adapter,不发任何 `cache_control` 标记 — 当前 in-scope 的所有上游(GLM-4.6 / OpenAI / DeepSeek / OpenRouter)都是**自动缓存**模型,本轮只做"看得见"。

## 目标

- 现有 `OpenAICompatibleClient` 能识别 GLM / OpenAI / DeepSeek 三家的 usage shape,把 `cached_tokens` 归一化到 `StreamEvent.done.usage.cached`。
- Consumer 可注入自定义 `usageParser` 处理 kernel 不识别的上游,**不改 kernel 即可扩展**。
- Zod 协议事件 `MessageUsage` 可携带 cached,additive 升级,旧 consumer 无感。
- live test(GLM-4.6)能验证真实命中链路。

## 不在范围(本次)

- 任何新 provider adapter(Anthropic / Bedrock / Vertex / Foundry) — 守 `packages/mycli-web/CLAUDE.md` 约束。
- 主动发 `cache_control` / 显式 cache breakpoint。
- 调整 auto-compaction 策略以提高命中率(单独 spec)。
- 会话级累计报表 / 节省 token 估算。
- mycli-web 的 UI 改动(consumer 自由,本 spec 默认零 UI)。

这些都没有架构层面的阻塞,只是有意延后。

## 架构

变更全部落在 `packages/agent-kernel/`,`packages/mycli-web/` 不需要改一行代码就能继续工作(只是看不到 cached 数据)。

```
┌─ agent-kernel/src/core/OpenAICompatibleClient.ts ───────────────┐
│  NormalizedUsage      { in, out, cached? }                       │
│  UsageParser          (raw: unknown) => Pick<…,'cached'>         │
│  defaultUsageParser   识别 OpenAI / GLM / DeepSeek shape         │
│  ClientConfig         新增 usageParser?: UsageParser             │
│  streamChat()         done 事件吐 NormalizedUsage                │
└─────────────────────────────────────────────────────────────────┘
                          ▲ 被引用
                          │
┌─ agent-kernel/src/browser/rpc/protocol.ts ──────────────────────┐
│  MessageUsage Zod      新增可选字段 cached: nonneg int           │
└─────────────────────────────────────────────────────────────────┘
                          ▲ 被引用
                          │
┌─ agent-kernel/src/browser/agentService.ts ──────────────────────┐
│  把 client 给的 usage.cached 透传到 message/usage AgentEvent     │
└─────────────────────────────────────────────────────────────────┘
```

`defaultUsageParser` 是纯函数,完全可单测,不依赖 client 实例状态。Consumer 可以 import 它、包装它、或完全替换。

## Kernel API 变化

### 1. 新类型(`core/OpenAICompatibleClient.ts`)

```ts
export interface NormalizedUsage {
  in: number
  out: number
  /** Cached prompt tokens (provider-reported). undefined if provider doesn't expose it. */
  cached?: number
}

export type UsageParser = (rawUsage: unknown) => Pick<NormalizedUsage, 'cached'>

export const defaultUsageParser: UsageParser
```

### 2. `ClientConfig` 加可选字段

```ts
export interface ClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  fetchTimeoutMs?: number
  /** Override how cached_tokens is extracted from raw usage. Defaults to defaultUsageParser. */
  usageParser?: UsageParser
}
```

### 3. `StreamEvent.done.usage` 升级

`done.usage` 类型从 `{ in, out }` 改为 `NormalizedUsage`(加可选 `cached`)。所有现有 done 事件的消费方都向后兼容,因为 `cached` 是 optional。

### 4. Zod 协议(`browser/rpc/protocol.ts`)

```ts
const MessageUsage = Base.extend({
  kind: z.literal('message/usage'),
  messageId: Uuid,
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative().optional(),  // 新增
})
```

Additive,旧事件依然 parse 通过。

### 5. `agentService.ts` 透传

agentService 在 emit `message/usage` 时把 client 给的 `cached` 也带上(若有)。无新分支逻辑,只是字段透传。

## 默认 parser 识别的 shape

| Provider | usage 字段路径 | 说明 |
|---|---|---|
| OpenAI / GLM-4.6 | `usage.prompt_tokens_details.cached_tokens` | 标准 OpenAI 扩展字段 |
| DeepSeek | `usage.prompt_cache_hit_tokens` | DeepSeek 自定义;`prompt_cache_miss_tokens` 忽略(可由 in - cached 推出) |
| OpenRouter | 同上 | OpenRouter 透传上游 usage,默认 parser 同时尝试两条路径 |
| 未知 / 缺失 | — | 返回 `{ cached: undefined }`,**不抛错** |

伪代码:

```ts
export const defaultUsageParser: UsageParser = (raw) => {
  if (!raw || typeof raw !== 'object') return { cached: undefined }
  const u = raw as Record<string, any>
  // OpenAI / GLM
  const openaiPath = u.prompt_tokens_details?.cached_tokens
  if (typeof openaiPath === 'number') return { cached: openaiPath }
  // DeepSeek
  if (typeof u.prompt_cache_hit_tokens === 'number') {
    return { cached: u.prompt_cache_hit_tokens }
  }
  return { cached: undefined }
}
```

## 数据流

```
OpenAI-compatible LLM SSE
    │
    │  最后一个 chunk 含 usage 对象(stream_options.include_usage 已请求)
    ▼
OpenAICompatibleClient.streamChatInner
    │  解析 usage.prompt_tokens / completion_tokens(已有)
    │  调 cfg.usageParser ?? defaultUsageParser 解析 cached(新)
    ▼
yield { kind: 'done', ..., usage: { in, out, cached? } }
    │
    ▼
QueryEngine 把 done.usage 传到 agentService
    │
    ▼
agentService emit AgentEvent {
  kind: 'message/usage', messageId, input, output, cached?
}
    │
    ▼
RPC port → SW hub → content script → consumer 自由处理
```

## 错误处理

- `defaultUsageParser` 接到任何输入都不抛错,异常情况下返回 `{ cached: undefined }`(包括 `null`、非对象、缺字段、字段类型错)。
- 自定义 `usageParser` 抛错 → kernel catch 后退化为 `{ cached: undefined }` 并在 console.warn 打一行,不打断 done 事件流。
- Provider 完全不返回 usage(老 endpoint 不支持 `stream_options.include_usage`) → `done.usage` 整体为 `undefined`(已有行为,不变)。

## 测试策略

遵循项目 TDD-ish 风格,先写测试再写实现。

### Kernel 单测(新增,`packages/agent-kernel/tests/core/`)

- `defaultUsageParser.test.ts`(~6 case)
  - OpenAI shape: `{ prompt_tokens_details: { cached_tokens: 100 } }` → `cached=100`
  - GLM shape: 同 OpenAI(智谱沿用 OpenAI 字段)
  - DeepSeek shape: `{ prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }` → `cached=80`
  - 未知 shape: `{ foo: 1 }` → `cached=undefined`
  - null / undefined / 非对象输入 → `cached=undefined`,不抛
  - 字段类型错(string/null) → `cached=undefined`

- `OpenAICompatibleClient.cached.test.ts`(~3 case,扩现有 client mock fetch 测试)
  - mock SSE 流末尾带 OpenAI usage shape → `done.usage.cached` 正确
  - 自定义 `usageParser` 注入 → 覆盖默认
  - 自定义 `usageParser` 抛错 → 退化为 undefined,不打断流

- `protocol.cached.test.ts`(~2 case,扩现有 Zod 测试)
  - 含 cached 的 `message/usage` 事件 parse 通过
  - 不含 cached 的旧事件依旧 parse 通过(向后兼容)

### Live test(扩 `tests/integration/agent.live.test.ts`)

- 加 1 个 case:发两轮一样的 system+history,断言**第二轮** `usage.cached` 字段存在(GLM 自动缓存生效;不 assert `> 0`,因为冷缓存可能不命中)。
- 跟现有 8 个 live case 一起 skip-by-default,需要 env 才跑。

### Typecheck + 全套现有测试

- 改完后 `bun run typecheck` 必须 cold-cache 干净。
- 现有 144 个 test 必须全绿。
- consumer 端 `bun --cwd packages/mycli-web run build` 不能挂。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| GLM 偶发不返回 cached(冷缓存) | live test flake | live test 改为 assert "字段存在或为 undefined",不 assert `> 0` |
| DeepSeek 字段名以后改 | 默认 parser 漏匹配 | parser 可被 consumer 完全覆盖,kernel 升级独立 |
| Zod additive 升级被某 consumer 错误 strict-parse | 旧 consumer 拒收新事件 | additive 字段是 optional,Zod 默认非严格 |
| 新增 protocol 字段被遗漏在 IDB 持久化 | message/usage 历史记录里 cached 丢 | message store 持久化的是 ChatMessage 不是 AgentEvent;message/usage 只走实时 stream,不入 store。无影响。 |

## 前向兼容

未来若要加 Anthropic 原生 adapter(改 CLAUDE.md 约束后),`NormalizedUsage` + `UsageParser` 的形状已经为它留了位置:Anthropic SDK 的 `usage.cache_creation_input_tokens` 和 `usage.cache_read_input_tokens` 可以通过同样的 parser 接口归一化。

未来若要加"调整 compaction 策略以提高命中率"(单独 spec),本 spec 提供的 `cached` 数据正是它需要的反馈信号。

未来若要加会话级累计报表,基础数据(每轮 cached)已经在 `MessageUsage` 事件里。

## 文件清单(预估)

| 文件 | 改动 |
|---|---|
| `packages/agent-kernel/src/core/OpenAICompatibleClient.ts` | 加类型 + defaultUsageParser + 接 usageParser + done.usage 加 cached |
| `packages/agent-kernel/src/browser/rpc/protocol.ts` | MessageUsage 加可选 cached |
| `packages/agent-kernel/src/browser/agentService.ts` | emit 时透传 cached |
| `packages/agent-kernel/src/index.ts` | 导出 NormalizedUsage / UsageParser / defaultUsageParser |
| `packages/agent-kernel/tests/core/defaultUsageParser.test.ts` | 新增 |
| `packages/agent-kernel/tests/core/OpenAICompatibleClient.cached.test.ts` | 新增 |
| `packages/agent-kernel/tests/browser/rpc/protocol.cached.test.ts` | 扩现有 |
| `tests/integration/agent.live.test.ts` | 加 1 个 live case |

约 80 LOC kernel 改动 + ~120 LOC 测试,改 5-6 个文件。

## 估时

走 writing-plans 大约会拆 4-5 个 TDD task,顺序执行约半个工作日(含 live 验证)。
