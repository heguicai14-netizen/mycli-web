import { makeError } from '@core/Tool'
import type { ToolDefinition } from '@core'

export const readSelectionTool: ToolDefinition<Record<string, never>, { text: string }> = {
  name: 'readSelection',
  description: "Read the user's currently selected text on the active tab.",
  inputSchema: { type: 'object', properties: {} },
  exec: 'content',
  async execute(_input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', 'no active tab')
    return (await ctx.rpc.domOp({ kind: 'dom/readSelection', tabId: ctx.tabId })) as any
  },
}
