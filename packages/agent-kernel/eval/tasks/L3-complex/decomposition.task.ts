import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/decomposition',
  level: 'L3',
  prompt:
    '我想了解这个 PR 的影响范围：列出所有改动的文件，找出其中哪些是 test 文件，对应到测的是哪些 src 文件。',
  fixtures: {
    snapshot: 'pr-page.html',
    fetchMap: {
      'https://api.github.example/pr/88/files': JSON.stringify([
        { filename: 'src/parser.ts', additions: 40 },
        { filename: 'src/lexer.ts',  additions: 15 },
        { filename: 'tests/parser.test.ts', additions: 60 },
        { filename: 'tests/lexer.test.ts',  additions: 20 },
      ]),
    },
  },
  budget: { expectedSteps: 6, expectedTokens: 6000, expectedDurMs: 14000, maxSteps: 12 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /parser\.test\.ts/ },
      { kind: 'answer-contains', value: /src\/parser\.ts/ },
      { kind: 'answer-contains', value: /lexer/ },
    ],
    trace: [
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'tool-called', name: 'fetchGet' },
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
    llm: {
      question: '是否正确把 tests/parser.test.ts ↔ src/parser.ts 与 tests/lexer.test.ts ↔ src/lexer.ts 配对？',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['complex', 'decomposition', 'multi-tool'],
}
