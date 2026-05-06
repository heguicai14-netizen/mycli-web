import type { ToolResult, ConversationId } from '@core'

export interface ExtensionToolRpc {
  domOp(op: unknown, timeoutMs?: number): Promise<ToolResult>
  chromeApi(method: string, args: unknown[]): Promise<ToolResult>
}

export interface ExtensionToolCtx {
  rpc: ExtensionToolRpc
  tabId?: number
  conversationId?: ConversationId
}
