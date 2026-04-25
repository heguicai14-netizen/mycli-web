import type { ToolDefinition } from '@shared/types'

interface TabSummary {
  id: number
  url: string
  title: string
  active: boolean
}

export const listTabsTool: ToolDefinition<Record<string, never>, { tabs: TabSummary[] }> = {
  name: 'listTabs',
  description: 'List all open browser tabs (id, url, title, active).',
  inputSchema: { type: 'object', properties: {} },
  exec: 'sw',
  async execute(_input, ctx) {
    return (await ctx.rpc.chromeApi('tabs.query', [{}])) as any
  },
}
