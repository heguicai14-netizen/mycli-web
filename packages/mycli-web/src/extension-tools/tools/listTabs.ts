import type { ToolDefinition } from 'agent-kernel'
import type { ExtensionToolCtx } from '../ctx'

interface TabSummary {
  id: number
  url: string
  title: string
  active: boolean
}

export const listTabsTool: ToolDefinition<Record<string, never>, { tabs: TabSummary[] }, ExtensionToolCtx> = {
  name: 'listTabs',
  description: 'List all open browser tabs (id, url, title, active).',
  inputSchema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    return (await ctx.rpc.chromeApi('tabs.query', [{}])) as any
  },
}
