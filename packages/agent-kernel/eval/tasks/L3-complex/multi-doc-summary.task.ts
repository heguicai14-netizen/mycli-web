import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/multi-doc-summary',
  level: 'L3',
  prompt:
    '按这个顺序处理(用 todoWrite 管理进度):\n' +
    '① 读 doc-a.html 摘要\n' +
    '② 读 doc-b.html 摘要\n' +
    '③ 对比写最终结论\n' +
    '完成后所有 todo 标 completed。',
  fixtures: {
    tabs: ['doc-a.html', 'doc-b.html'],
  },
  budget: { expectedSteps: 6, expectedTokens: 5000, expectedDurMs: 4000, maxSteps: 14 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /对比|comparison|difference/i },
    ],
    trace: [
      { kind: 'todo-written', minItems: 3 },
      { kind: 'todo-final-status', allCompleted: true },
      { kind: 'tool-called', name: 'readPage', argsMatch: { url: 'doc-a.html' } },
      { kind: 'tool-called', name: 'readPage', argsMatch: { url: 'doc-b.html' } },
    ],
    llm: {
      question: '三步是否按 todo 顺序完成,最终对比合理?',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['todo', 'sequential'],
}
