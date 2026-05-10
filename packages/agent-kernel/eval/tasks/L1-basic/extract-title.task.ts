import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/extract-title',
  level: 'L1',
  prompt: '这个页面的标题是什么？',
  fixtures: { snapshot: 'github-issue-1234.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /Issue\s*#?\s*1234/ }],
    trace: [{ kind: 'tool-called', name: 'readPage' }],
  },
  tags: ['basic', 'extraction'],
}
