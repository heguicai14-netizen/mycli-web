import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/get-by-selector',
  level: 'L1',
  prompt: '页面上 .price 这个元素的文本是什么？',
  fixtures: { snapshot: 'product-page.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: '$29.99' }],
    trace: [{ kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.price' } }],
  },
  tags: ['basic', 'selector'],
}
