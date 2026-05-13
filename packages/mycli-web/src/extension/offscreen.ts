// IMPORTANT: polyfill must run before any module touches chrome.storage /
// chrome.tabs. Other imports below are side-effect-free at module level.
import { polyfillChromeApiInOffscreen } from 'agent-kernel'
polyfillChromeApiInOffscreen()

import {
  bootKernelOffscreen,
  createIdbMessageStore,
  sendDomOp,
  callChromeApi,
  fetchGetTool,
  type ToolContextBuilder,
} from 'agent-kernel'
import { extensionTools, type ExtensionToolCtx, type ExtensionToolRpc } from '@ext-tools'
import { allSubagentTypes } from '@ext-tools/subagentTypes'
import { useSkillTool, readSkillFileTool } from '@ext-skills'
import { mycliSettingsAdapter } from './settingsAdapter'
import { mycliApprovalAdapter } from './mycliApprovalAdapter'
import { buildApprovalContext } from './approvalContextBuilder'

async function guessActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return tabs[0]
  } catch {
    return undefined
  }
}

// ExtensionToolCtx doesn't carry an index signature so the generic constraint
// `Record<string, unknown>` rejects it directly; cast through unknown — the
// agent loop passes the ctx verbatim to tools that already expect this shape.
const mycliToolContext = {
  async build(cid: string | undefined): Promise<ExtensionToolCtx> {
    const tabId = (await guessActiveTab())?.id
    const rpc: ExtensionToolRpc = {
      domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
      chromeApi: (method, args) => callChromeApi(method, args),
    }
    return { rpc, tabId, conversationId: cid }
  },
} as unknown as ToolContextBuilder

bootKernelOffscreen({
  settings: mycliSettingsAdapter,
  messageStore: createIdbMessageStore({ defaultConversationTitle: 'New chat' }),
  toolContext: mycliToolContext,
  // Kernel default is just [fetchGetTool]; extend with mycli-web's
  // extension/skill tool sets explicitly.
  tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool],
  subagentTypes: allSubagentTypes,
  approvalAdapter: mycliApprovalAdapter,
  buildApprovalContext,
})
