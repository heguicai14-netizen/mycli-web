export type { ExtensionToolCtx, ExtensionToolRpc } from './ctx'
export { DomOp } from './DomOp'

import type { ToolDefinition } from '@core'
import type { ExtensionToolCtx } from './ctx'
import { readPageTool } from './tools/readPage'
import { readSelectionTool } from './tools/readSelection'
import { querySelectorTool } from './tools/querySelector'
import { screenshotTool } from './tools/screenshot'
import { listTabsTool } from './tools/listTabs'

export {
  readPageTool,
  readSelectionTool,
  querySelectorTool,
  screenshotTool,
  listTabsTool,
}

/** All chrome-extension-only tools, ready to register on a chrome-backed agent. */
export const extensionTools: ToolDefinition<any, any, ExtensionToolCtx>[] = [
  readPageTool,
  readSelectionTool,
  querySelectorTool,
  screenshotTool,
  listTabsTool,
]
