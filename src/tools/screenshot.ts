import { makeError } from '@core/Tool'
import type { ToolDefinition } from '@core'

export const screenshotTool: ToolDefinition<Record<string, never>, { dataUrl: string }> = {
  name: 'screenshot',
  description: 'Capture a screenshot of the visible area of the active tab.',
  inputSchema: { type: 'object', properties: {} },
  exec: 'sw',
  async execute(_input, ctx) {
    if (ctx.tabId === undefined) return makeError('no_active_tab', 'no active tab')
    return (await ctx.rpc.chromeApi('tabs.captureVisibleTab', [])) as any
  },
}
