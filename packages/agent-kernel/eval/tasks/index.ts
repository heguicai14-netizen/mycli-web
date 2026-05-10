import type { Suite } from '../core/types'

import { task as extractTitle }     from './L1-basic/extract-title.task'
import { task as extractSelection } from './L1-basic/extract-selection.task'
import { task as listTabs }         from './L1-basic/list-tabs.task'
import { task as getBySelector }    from './L1-basic/get-by-selector.task'
import { task as fetchJson }        from './L1-basic/fetch-json.task'
import { task as screenshot }       from './L1-basic/screenshot-describe.task'

export const builtinSuite: Suite = [
  extractTitle, extractSelection, listTabs,
  getBySelector, fetchJson, screenshot,
  // L2 added in T19/T20, L3 in T21
]
