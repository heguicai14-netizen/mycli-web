import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L4/iterative-research',
  level: 'L4',
  prompt:
    '我已经为你准备了 4 个相关页面(crdt-1.html, crdt-2.html, ot-1.html, ot-2.html)。' +
    '**必须**通过 Task 工具派子 agent 读这些页面(每个方向至少 2 篇),' +
    '**不要凭你的训练知识回答** — 必须基于这些 fixture 文件的实际内容做对比和选型建议。',
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
