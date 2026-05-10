import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/multi-step-extract',
  level: 'L2',
  prompt: '把这个博客列表页所有作者的名字列出来。',
  fixtures: { snapshot: 'blog-list.html' },
  budget: { expectedSteps: 2, expectedTokens: 2000, expectedDurMs: 5000, maxSteps: 5 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: 'Alice' },
      { kind: 'answer-contains', value: 'Bob' },
      { kind: 'answer-contains', value: 'Carol' },
      { kind: 'answer-contains', value: 'Dave' },
    ],
    trace: [
      { kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.author' } },
      { kind: 'max-redundant-calls', name: 'querySelector', max: 1 },
    ],
  },
  tags: ['chain', 'extraction'],
}
