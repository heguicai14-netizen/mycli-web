import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L4/parallel-issue-triage',
  level: 'L4',
  prompt:
    '调研这 3 个 GitHub issue 并给我优先级排序(P0/P1/P2),' +
    '附简要说明:\n' +
    '- https://api.github.example/issue/101\n' +
    '- https://api.github.example/issue/102\n' +
    '- https://api.github.example/issue/103',
  fixtures: {
    fetchMap: {
      'https://api.github.example/issue/101': JSON.stringify({ title: 'Login fails for SSO users', body: 'Critical regression in production.', priority_hint: 'P0' }),
      'https://api.github.example/issue/102': JSON.stringify({ title: 'Dropdown styling glitch', body: 'Minor visual issue on Safari.', priority_hint: 'P2' }),
      'https://api.github.example/issue/103': JSON.stringify({ title: 'Logs missing user_id', body: 'Affects debugging, no user impact.', priority_hint: 'P1' }),
    },
    slowFetchDelayMs: 500,
  } as any,
  budget: { expectedSteps: 6, expectedTokens: 5000, expectedDurMs: 3000, maxSteps: 14 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /P0/ },
      { kind: 'answer-contains', value: /P1/ },
      { kind: 'answer-contains', value: /P2/ },
    ],
    trace: [
      { kind: 'subagent-spawned', type: 'explore', minCount: 2 },
      { kind: 'subagent-parallel', minCount: 2 },
    ],
    llm: {
      question: '三个 issue 是否都被独立分析且给了合理的优先级理由?',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['subagent', 'parallel', 'capability'],
}
