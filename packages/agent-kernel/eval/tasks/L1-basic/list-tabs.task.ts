import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/list-tabs',
  level: 'L1',
  prompt: '我现在打开了哪些 tab？给我标题列表。',
  fixtures: {
    tabs: [
      'multi-tab-context/tab-a.html',
      'multi-tab-context/tab-b.html',
      'article.html',
    ],
  },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: 'monorepo' },
      { kind: 'answer-contains', value: /scaling|agents/i },
    ],
    trace: [{ kind: 'tool-called', name: 'listTabs' }],
  },
  tags: ['basic', 'multi-tab'],
}
