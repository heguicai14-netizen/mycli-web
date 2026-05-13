import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L4/iterative-research',
  level: 'L4',
  prompt: '调研 CRDT 和 OT 两个方向,每方向找 2 篇相关页面,综合给我对比和选型建议。',
  fixtures: {
    tabs: ['crdt-1.html', 'crdt-2.html', 'ot-1.html', 'ot-2.html'],
  },
  budget: { expectedSteps: 10, expectedTokens: 10000, expectedDurMs: 8000, maxSteps: 20 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /CRDT/ },
      { kind: 'answer-contains', value: /OT/ },
    ],
    trace: [
      { kind: 'subagent-spawned', minCount: 2 },
      { kind: 'subagent-final-ok', minCount: 2 },
    ],
    llm: {
      question: '两个方向是否都基于多页材料给了对比结论?',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['subagent', 'decomposition', 'capability'],
}
