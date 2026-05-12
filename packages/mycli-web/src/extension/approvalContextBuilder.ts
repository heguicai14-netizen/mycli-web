import { buildActiveTabApprovalContext } from 'agent-kernel'
import type { ApprovalContext, ToolCall } from 'agent-kernel'

/**
 * mycli-web's ApprovalContext builder: kernel's active-tab utility + selector
 * extraction (mycli-web-specific because tool names that carry selectors are
 * a mycli-web convention).
 */
export async function buildApprovalContext(call: ToolCall): Promise<ApprovalContext> {
  const base = await buildActiveTabApprovalContext()
  const selector = (call.input as { selector?: unknown })?.selector
  if (typeof selector === 'string') {
    return { ...base, selector }
  }
  return base
}
