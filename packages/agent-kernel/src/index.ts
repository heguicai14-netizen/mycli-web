// === core: agent loop & 协议（平台无关）===
export { createAgent, type CreateAgentOptions } from './core/createAgent'
export { AgentSession } from './core/AgentSession'
export {
  OpenAICompatibleClient,
  type ChatMessage,
  type StreamEvent,
} from './core/OpenAICompatibleClient'
export { QueryEngine, type EngineEvent } from './core/QueryEngine'
export { ToolRegistry } from './core/ToolRegistry'
export { toOpenAiTool, makeOk, makeError } from './core/Tool'
export { fetchGetTool } from './core/tools/fetchGet'
export { estimateTokens, estimateMessageTokens } from './core/tokenBudget'
export { AgentEvent } from './core/protocol'
export type {
  ToolDefinition,
  ToolExecContext,
  ToolResult,
  ToolCall,
  ToolCallId,
  ConversationId,
  MessageId,
  SkillId,
  ApprovalId,
  Uuid,
  Role,
  Message,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  ContentPart,
} from './core/types'

// === skills 协议 ===
export { parseSkillMd, type SkillDefinition, type ParsedSkillMd } from './skills/Skill'
export { SkillRegistry } from './skills/SkillRegistry'
export { createUseSkillTool } from './skills/useSkillTool'
export { createReadSkillFileTool } from './skills/readSkillFileTool'
