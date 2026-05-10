export { makeFakeReadPage } from './fakeReadPage'
export { makeFakeReadSelection } from './fakeReadSelection'
export { makeFakeQuerySelector } from './fakeQuerySelector'
export { makeFakeListTabs } from './fakeListTabs'
export { makeFakeScreenshot } from './fakeScreenshot'
export { makeFakeFetch } from './fakeFetch'
export { makeFakeUseSkill } from './fakeUseSkill'

import type { FakeToolFactory } from '../../core/types'
import { makeFakeReadPage } from './fakeReadPage'
import { makeFakeReadSelection } from './fakeReadSelection'
import { makeFakeQuerySelector } from './fakeQuerySelector'
import { makeFakeListTabs } from './fakeListTabs'
import { makeFakeScreenshot } from './fakeScreenshot'
import { makeFakeFetch } from './fakeFetch'
import { makeFakeUseSkill } from './fakeUseSkill'

export const allBuiltinFakes: FakeToolFactory[] = [
  makeFakeReadPage, makeFakeReadSelection, makeFakeQuerySelector,
  makeFakeListTabs, makeFakeScreenshot, makeFakeFetch, makeFakeUseSkill,
]
