export { makeFakeReadPage } from './fakeReadPage'
export { makeFakeReadSelection } from './fakeReadSelection'
export { makeFakeQuerySelector } from './fakeQuerySelector'
export { makeFakeListTabs } from './fakeListTabs'
export { makeFakeScreenshot } from './fakeScreenshot'
export { makeFakeFetch } from './fakeFetch'
export { makeFakeUseSkill } from './fakeUseSkill'
export { makeFakeSlowFetch } from './slowFetch'
export { makeFakeMarkRead } from './markRead'
export { makeFakeGrepFile } from './grepFile'
export { makeFakeEditFile } from './editFile'
export { makeFakeListFiles } from './listFiles'

import type { FakeToolFactory } from '../../core/types'
import { makeFakeReadPage } from './fakeReadPage'
import { makeFakeReadSelection } from './fakeReadSelection'
import { makeFakeQuerySelector } from './fakeQuerySelector'
import { makeFakeListTabs } from './fakeListTabs'
import { makeFakeScreenshot } from './fakeScreenshot'
import { makeFakeFetch } from './fakeFetch'
import { makeFakeUseSkill } from './fakeUseSkill'
import { makeFakeSlowFetch } from './slowFetch'
import { makeFakeMarkRead } from './markRead'
import { makeFakeGrepFile } from './grepFile'
import { makeFakeEditFile } from './editFile'
import { makeFakeListFiles } from './listFiles'

export const allBuiltinFakes: FakeToolFactory[] = [
  makeFakeReadPage, makeFakeReadSelection, makeFakeQuerySelector,
  makeFakeListTabs, makeFakeScreenshot, makeFakeFetch, makeFakeUseSkill,
  makeFakeSlowFetch, makeFakeMarkRead, makeFakeGrepFile,
  makeFakeEditFile, makeFakeListFiles,
]
