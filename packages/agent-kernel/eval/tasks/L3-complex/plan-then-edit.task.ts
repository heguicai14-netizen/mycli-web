import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/plan-then-edit',
  level: 'L3',
  prompt:
    '我要把 src/parser.ts 重命名为 src/lexer.ts。请用 todoWrite 列计划,' +
    '用 grepFile 找出引用 parser.ts 的文件,然后用 editFile 逐文件改。' +
    '完成后所有 todo 标 completed。',
  fixtures: {
    grepMap: {
      'parser.ts': ['src/parser.ts', 'src/main.ts', 'tests/parser.test.ts', 'docs/parser.md', 'README.md'],
    },
  } as any,
  budget: { expectedSteps: 8, expectedTokens: 4000, expectedDurMs: 5000, maxSteps: 16 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /lexer/i },
    ],
    trace: [
      { kind: 'todo-written', minItems: 4 },
      { kind: 'todo-final-status', allCompleted: true },
      { kind: 'tool-called', name: 'todoWrite' },
    ],
    llm: {
      question: 'todo 是否每步合理标记 in_progress → completed,并完成了 grep 找到的所有引用的 edit?',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['todo', 'multi-step'],
}
