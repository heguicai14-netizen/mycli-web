import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/issue-summary',
  level: 'L2',
  prompt: '总结这个 issue：标题、状态、最近 3 条评论。',
  fixtures: {
    snapshot: 'github-issue-1234.html',
    // Surface the issue page in listTabs too — without this hint, the model
    // sometimes calls listTabs first, gets an empty list, and gives up
    // instead of trying readPage on the bound active tab.
    tabs: ['github-issue-1234.html'],
  },
  budget: { expectedSteps: 5, expectedTokens: 4000, expectedDurMs: 8000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /Issue\s*#?\s*1234/ },
      { kind: 'answer-contains', value: /open|打开/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'max-redundant-calls', name: 'readPage', max: 1 },
    ],
    llm: {
      question: '答案是否覆盖了标题、状态、最近评论 3 个要素？',
      scale: '0-5',
      weight: 1,
    },
  },
  tags: ['chain', 'extraction'],
}
