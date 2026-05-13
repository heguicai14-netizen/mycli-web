import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/refactor-walkthrough',
  level: 'L3',
  prompt:
    '我要给项目加 logging 中间件。请用 todoWrite 列实施步骤,' +
    '用 listFiles 看目录结构,然后用 editFile 给至少 3 个文件加 logging 调用。' +
    '完成后所有 todo 标 completed。',
  fixtures: {
    listFilesMap: {
      '*': ['src/server.ts', 'src/routes/users.ts', 'src/routes/orders.ts', 'src/db.ts'],
    },
  } as any,
  budget: { expectedSteps: 10, expectedTokens: 5500, expectedDurMs: 6000, maxSteps: 18 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /logging|log/i },
    ],
    trace: [
      { kind: 'todo-written', minItems: 5 },
      { kind: 'todo-final-status', allCompleted: true },
    ],
    llm: {
      question: '实施步骤是否合理 + 至少 3 个文件改动符合 logging 中间件意图?',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['todo', 'multi-step', 'planning'],
}
