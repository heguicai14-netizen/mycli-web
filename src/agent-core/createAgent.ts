import { AgentSession } from './AgentSession'
import { OpenAICompatibleClient } from './OpenAICompatibleClient'
import { ToolRegistry } from './ToolRegistry'
import type { ToolDefinition } from './types'

export interface CreateAgentOptions<ExtraCtx = Record<string, never>> {
  /** OpenAI-compatible 配置；二选一：llm（自动构造 client）或 llmClient（自带实例，便于测试） */
  llm?: { apiKey: string; baseUrl: string; model: string }
  llmClient?: OpenAICompatibleClient
  /**
   * 工具数组。第三泛型 `any` 故意放宽，允许混合 `ToolDefinition<I, O>`（基础 ctx）与
   * `ToolDefinition<I, O, ExtraCtx>`（特化 ctx）——前者忽略 ExtraCtx 字段，后者读取。
   * 注入的 toolContext 必须满足"读它的工具"所需的字段。
   */
  tools: Array<ToolDefinition<any, any>>
  toolContext: ExtraCtx
  systemPrompt?: string
  toolMaxIterations?: number
}

export function createAgent<ExtraCtx>(opts: CreateAgentOptions<ExtraCtx>): AgentSession<ExtraCtx> {
  if (!opts.llmClient && !opts.llm) {
    throw new Error('createAgent: must provide either llm or llmClient')
  }
  const client = opts.llmClient ?? new OpenAICompatibleClient(opts.llm!)
  const registry = new ToolRegistry()
  for (const t of opts.tools) registry.register(t)
  return new AgentSession<ExtraCtx>({
    llmClient: client,
    registry,
    toolContext: opts.toolContext,
    systemPrompt: opts.systemPrompt,
    toolMaxIterations: opts.toolMaxIterations,
  })
}
