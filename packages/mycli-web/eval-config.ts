import { builtinSuite } from 'agent-kernel/eval'
import type { LlmConfig } from 'agent-kernel/eval'

const llm: LlmConfig = {
  apiKey:  process.env.MYCLI_LLM_API_KEY  ?? '',
  baseUrl: process.env.MYCLI_LLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
  model:   process.env.MYCLI_LLM_MODEL    ?? 'glm-4.6',
  fetchTimeoutMs: 60_000,
}

const judgeLLM: LlmConfig | undefined = process.env.MYCLI_JUDGE_LLM_API_KEY
  ? {
      apiKey:  process.env.MYCLI_JUDGE_LLM_API_KEY,
      baseUrl: process.env.MYCLI_JUDGE_LLM_BASE_URL ?? llm.baseUrl,
      model:   process.env.MYCLI_JUDGE_LLM_MODEL    ?? 'glm-4.5-flash',
    }
  : undefined

export default {
  llm,
  judgeLLM,
  suite: builtinSuite,
  reporter: ['console', 'markdown', 'json'] as const,
  outDir: './eval-out',
}
