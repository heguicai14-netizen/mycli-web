import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/fail-then-fallback',
  level: 'L2',
  prompt: '拿 https://broken.example/x 的内容总结一下。',
  fixtures: {
    fetchMap: {
      'https://broken.example/x': { body: '', status: 500, failOnce: false },
    },
  },
  budget: { expectedSteps: 3, expectedTokens: 2500, expectedDurMs: 6000, maxSteps: 5 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /失败|fail|无法|error|500/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet' },
      // recovery: do not retry the same URL more than once
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
  },
  tags: ['chain', 'recovery'],
}
