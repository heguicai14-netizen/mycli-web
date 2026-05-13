import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L4/fail-isolation',
  level: 'L4',
  prompt:
    '调研这 4 个 npm 包,告诉我每个的 last published version:\n' +
    '- https://registry.npmjs.example/foo\n' +
    '- https://registry.npmjs.example/bar\n' +
    '- https://registry.npmjs.example/baz\n' +
    '- https://registry.npmjs.example/qux',
  fixtures: {
    fetchMap: {
      'https://registry.npmjs.example/foo': JSON.stringify({ version: '1.2.3' }),
      'https://registry.npmjs.example/bar': JSON.stringify({ version: '0.5.1' }),
      'https://registry.npmjs.example/baz': { body: 'not found', status: 404 },
      'https://registry.npmjs.example/qux': JSON.stringify({ version: '2.0.0' }),
    },
  },
  budget: { expectedSteps: 7, expectedTokens: 5000, expectedDurMs: 4000, maxSteps: 14 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /1\.2\.3/ },
      { kind: 'answer-contains', value: /0\.5\.1/ },
      { kind: 'answer-contains', value: /2\.0\.0/ },
    ],
    trace: [
      { kind: 'subagent-spawned', minCount: 3, maxCount: 4 },
      { kind: 'subagent-final-ok', minCount: 3 },
    ],
    llm: {
      question: '失败的那个包(baz)是否被诚实报告,且其他 3 个成功的没被一并丢弃?',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['subagent', 'fail-isolation', 'capability'],
}
