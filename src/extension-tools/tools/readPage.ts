import { makeError } from '@core/Tool'
import type { ToolDefinition } from '@core'
import type { ExtensionToolCtx } from '../ctx'

interface ReadPageInput {
  mode?: 'text' | 'markdown' | 'html-simplified'
}

interface ReadPageOutput {
  text: string
  url?: string
  title?: string
}

export const readPageTool: ToolDefinition<ReadPageInput, ReadPageOutput, ExtensionToolCtx> = {
  name: 'readPage',
  description: 'Read the current page content as text, markdown, or simplified HTML.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['text', 'markdown', 'html-simplified'],
        default: 'text',
      },
    },
  },
  async execute(input, ctx) {
    if (ctx.tabId === undefined) {
      return makeError('no_active_tab', 'no active tab to read from')
    }
    const mode = input.mode ?? 'text'
    return (await ctx.rpc.domOp(
      { kind: 'dom/readPage', tabId: ctx.tabId, mode },
      30_000,
    )) as any
  },
}
