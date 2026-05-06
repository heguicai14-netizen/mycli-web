import { makeError } from '@core/Tool'
import type { ToolDefinition } from '@core'

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

export const querySelectorTool: ToolDefinition<Input, Output> = {
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
  exec: 'content',
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
