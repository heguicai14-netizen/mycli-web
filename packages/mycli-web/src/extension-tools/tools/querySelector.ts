import { makeError } from 'agent-kernel'
import type { ToolDefinition } from 'agent-kernel'
import type { ExtensionToolCtx } from '../ctx'

interface Input {
  selector: string
  all?: boolean
}
interface Output {
  matches: Array<{
    text: string
    outerHtml: string
    rect: { x: number; y: number; width: number; height: number }
  }>
}

export const querySelectorTool: ToolDefinition<Input, Output, ExtensionToolCtx> = {
  name: 'querySelector',
  description: 'Find DOM elements on the active tab matching a CSS selector.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector' },
      all: {
        type: 'boolean',
        description: 'Return all matches (default just first)',
        default: false,
      },
    },
    required: ['selector'],
  },
  async execute(input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', 'no active tab')
    return (await ctx.rpc.domOp({
      kind: 'dom/querySelector',
      tabId: ctx.tabId,
      selector: input.selector,
      all: input.all ?? false,
    })) as any
  },
}
