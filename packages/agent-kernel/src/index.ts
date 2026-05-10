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

// === browser RPC ===
export { installHub, type HubHandle } from './browser/rpc/hub'
export { RpcClient } from './browser/rpc/client'
// Wire-protocol AgentEvent is a separate Zod-validated discriminated union
// from the core engine event. Re-export under a distinct name to avoid
// collision with the core AgentEvent above. The renamed identifier carries
// both the runtime Zod schema and the inferred type (TS dual-meaning).
export { ClientCmd, AgentEvent as WireAgentEvent, Envelope } from './browser/rpc/protocol'

// === browser agent client SDK ===
export { createAgentClient } from './browser/agentClient'
export type {
  AgentClient,
  MessageOptions,
  OneShotOptions,
  OneShotResult,
  OneShotToolCall,
  CreateAgentClientOptions,
} from './browser/agentClient'

// === browser agent service ===
export {
  createAgentService,
  type AgentService,
  type AgentServiceDeps,
  type RunTurnInput,
} from './browser/agentService'

// === adapters ===
export type { Settings, SettingsAdapter } from './adapters'

// === browser RPC helpers / chrome.* polyfill ===
export { sendDomOp, callChromeApi } from './browser/domOpClient'
export { installDomOpRouter } from './browser/domOpRouter'
export { polyfillChromeApiInOffscreen } from './browser/offscreenChromePolyfill'

// === browser storage (default IDB-backed conversation/message/audit stores) ===
export {
  openDb,
  resetDbForTests,
  DB_NAME,
  DB_VERSION,
  type ConversationRow,
  type MessageRow,
  type SkillRow,
  type SkillDataRow,
  type AuditLogRow,
  type MycliWebSchema,
} from './browser/storage/db'
export {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
} from './browser/storage/conversations'
export {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
  markMessagesCompacted,
  deleteMessagesByConversation,
} from './browser/storage/messages'
export {
  appendAudit,
  listAuditByConversation,
  listAuditByTimeRange,
  pruneAuditOlderThan,
} from './browser/storage/auditLog'
