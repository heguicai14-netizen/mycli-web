import type { ApprovalAdapter } from 'agent-kernel'
import { findMatchingRule, addRule } from './storage/rules'

export const mycliApprovalAdapter: ApprovalAdapter = {
  async check({ tool, ctx }) {
    const rule = await findMatchingRule({
      tool,
      origin: typeof ctx.origin === 'string' ? ctx.origin : undefined,
      selector: typeof ctx.selector === 'string' ? ctx.selector : undefined,
      url: typeof ctx.url === 'string' ? ctx.url : undefined,
    })
    if (!rule) return 'ask'
    return rule.decision  // 'allow' | 'deny'
  },
  async recordRule({ tool, ctx }, decision) {
    const origin = typeof ctx.origin === 'string' ? ctx.origin : undefined
    await addRule({
      tool,
      scope: origin ? { kind: 'origin', origin } : { kind: 'global' },
      decision,
    })
  },
}
