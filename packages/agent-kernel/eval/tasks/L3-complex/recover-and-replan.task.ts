import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/recover-and-replan',
  level: 'L3',
  prompt: '帮我看看页面上 .nonexistent 元素的内容是什么。',
  fixtures: { snapshot: 'landing-page.html' },
  budget: { expectedSteps: 4, expectedTokens: 3500, expectedDurMs: 8000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /没有|无|not.*found|不存在|no match/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'querySelector', argsMatch: { selector: '.nonexistent' } },
      { kind: 'max-redundant-calls', name: 'querySelector', max: 1 },
    ],
  },
  tags: ['complex', 'recovery'],
}
