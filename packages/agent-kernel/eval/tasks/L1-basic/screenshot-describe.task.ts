import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/screenshot-describe',
  level: 'L1',
  prompt: '帮我看下当前页面长啥样，简单描述一下。',
  fixtures: { snapshot: 'landing-page.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /landing|Acme|automate|登陆|落地/i }],
    trace: [{ kind: 'tool-called', name: 'screenshot' }],
  },
  tags: ['basic', 'visual'],
}
