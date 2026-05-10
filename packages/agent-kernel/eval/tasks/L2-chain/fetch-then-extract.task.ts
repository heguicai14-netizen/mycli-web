import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/fetch-then-extract',
  level: 'L2',
  prompt: '从 https://api.github.example/issue/1234/labels 拿 labels 列表，告诉我有几个。',
  fixtures: {
    fetchMap: {
      'https://api.github.example/issue/1234/labels': JSON.stringify([
        { name: 'bug' }, { name: 'memory' }, { name: 'p1' },
      ]),
    },
  },
  budget: { expectedSteps: 2, expectedTokens: 1500, expectedDurMs: 5000, maxSteps: 4 },
  judge: {
    completion: [{ kind: 'answer-contains', value: '3' }],
    trace: [{ kind: 'tool-called', name: 'fetchGet' }],
  },
  tags: ['chain', 'fetch'],
}
