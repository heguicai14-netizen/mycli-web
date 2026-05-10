import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/fetch-json',
  level: 'L1',
  prompt: '拿 https://api.example/items 的 JSON，告诉我第一项的 name 字段。',
  fixtures: {
    fetchMap: {
      'https://api.example/items': JSON.stringify([
        { name: 'Widget', price: 9.99 },
        { name: 'Gizmo',  price: 14.99 },
      ]),
    },
  },
  budget: { expectedSteps: 2, expectedTokens: 1500, expectedDurMs: 5000, maxSteps: 4 },
  judge: {
    completion: [{ kind: 'answer-contains', value: 'Widget' }],
    trace: [{ kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /api\.example\/items/ } }],
  },
  tags: ['basic', 'fetch'],
}
