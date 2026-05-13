import type { Suite, Task } from '../core/types'

import { task as extractTitle }     from './L1-basic/extract-title.task'
import { task as extractSelection } from './L1-basic/extract-selection.task'
import { task as listTabs }         from './L1-basic/list-tabs.task'
import { task as getBySelector }    from './L1-basic/get-by-selector.task'
import { task as fetchJson }        from './L1-basic/fetch-json.task'
import { task as screenshot }       from './L1-basic/screenshot-describe.task'

import { task as issueSummary }        from './L2-chain/issue-summary.task'
import { task as crossTabCompare }     from './L2-chain/cross-tab-compare.task'
import { task as fetchThenExtract }    from './L2-chain/fetch-then-extract.task'
import { task as conditionalBranch }   from './L2-chain/conditional-branch.task'
import { task as multiStepExtract }    from './L2-chain/multi-step-extract.task'
import { task as failThenFallback }    from './L2-chain/fail-then-fallback.task'
import { task as expTreatmentReadout } from './L2-chain/exp-treatment-readout.task'
import { task as expCrossValidate }    from './L2-chain/exp-cross-validate.task'

import { task as skillOrchestration } from './L3-complex/skill-orchestration.task'
import { task as decomposition }      from './L3-complex/decomposition.task'
import { task as recoverAndReplan }   from './L3-complex/recover-and-replan.task'
import { task as expGoNoGo }          from './L3-complex/exp-go-no-go.task'
import { task as planThenEdit }       from './L3-complex/plan-then-edit.task'
import { task as multiDocSummary }    from './L3-complex/multi-doc-summary.task'
import { task as refactorWalkthrough } from './L3-complex/refactor-walkthrough.task'

import { task as parallelIssueTriage }    from './L4-subagent/parallel-issue-triage.task'
import { task as crossPageSynthesis }     from './L4-subagent/cross-page-synthesis.task'
import { task as iterativeResearch }      from './L4-subagent/iterative-research.task'
import { task as distractorResistance }   from './L4-subagent/distractor-resistance.task'
import { task as failIsolation }          from './L4-subagent/fail-isolation.task'
import { task as overDecompositionTrap }  from './L4-subagent/over-decomposition-trap.task'

export const builtinSuite: Suite = [
  extractTitle, extractSelection, listTabs, getBySelector, fetchJson, screenshot,
  issueSummary, crossTabCompare, fetchThenExtract, conditionalBranch,
  multiStepExtract, failThenFallback, expTreatmentReadout, expCrossValidate,
  skillOrchestration, decomposition, recoverAndReplan, expGoNoGo,
  planThenEdit, multiDocSummary, refactorWalkthrough,
  parallelIssueTriage, crossPageSynthesis, iterativeResearch,
  distractorResistance, failIsolation, overDecompositionTrap,
]

// IDs that smoke mode runs (PR-time, with replay)
export const smokeIds: string[] = [
  ...['L1/extract-title', 'L1/extract-selection', 'L1/list-tabs',
      'L1/get-by-selector', 'L1/fetch-json', 'L1/screenshot-describe'],
  'L2/issue-summary',
  'L2/exp-treatment-readout',
  'L3/plan-then-edit',
  'L4/over-decomposition-trap',
  'L4/parallel-issue-triage',
]

export function filterSuite(
  suite: Suite,
  filter?: { levels?: Task['level'][]; tags?: string[]; ids?: string[] },
): Suite {
  if (!filter) return suite
  return suite.filter((t) => {
    if (filter.ids && !filter.ids.includes(t.id)) return false
    if (filter.levels && !filter.levels.includes(t.level)) return false
    if (filter.tags && !(t.tags ?? []).some((tag) => filter.tags!.includes(tag))) return false
    return true
  })
}
