import { makeError } from 'agent-kernel'
import type { ToolDefinition } from 'agent-kernel'
import type { ExtensionToolCtx } from '../ctx'

export const readSelectionTool: ToolDefinition<Record<string, never>, { text: string }, ExtensionToolCtx> = {
  name: 'readSelection',
  description: "Read the user's currently selected text on the active tab.",
  inputSchema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', 'no active tab')
    return (await ctx.rpc.domOp({ kind: 'dom/readSelection', tabId: ctx.tabId })) as any
  },
}
