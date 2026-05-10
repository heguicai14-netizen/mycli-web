import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/conditional-branch',
  level: 'L2',
  prompt:
    '如果这个页面有 .error 元素就告诉我错误内容；否则总结一下页面主要内容。',
  // NOTE: Only covers the if-branch (.error present). The else-branch test using
  // page-clean.html is deferred — split into a second task in a follow-up PR.
  fixtures: { snapshot: 'page-with-error.html' },
  budget: { expectedSteps: 3, expectedTokens: 2500, expectedDurMs: 6000, maxSteps: 6 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /Connection refused/ }],
    trace: [
      { kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.error' } },
      // Should NOT need readPage when error is found
      { kind: 'tool-not-called', name: 'readPage' },
    ],
  },
  tags: ['chain', 'conditional'],
}
