import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L4/over-decomposition-trap',
  level: 'L4',
  prompt: '读 simple-page.html 这一页的 title 标签内容并返回。',
  fixtures: {
    snapshot: 'simple-page.html',
  },
  budget: { expectedSteps: 2, expectedTokens: 800, expectedDurMs: 1500, maxSteps: 5 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /Simple Page Title/ },
    ],
    trace: [
      { kind: 'subagent-not-spawned' },
      { kind: 'tool-called', name: 'readPage' },
    ],
  },
  tags: ['subagent', 'decision-trap', 'reverse', 'capability'],
}
