import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L4/cross-page-synthesis',
  level: 'L4',
  prompt: '对比 product-a.html 和 product-b.html 两个产品文档,告诉我各自优劣和该选哪个。',
  fixtures: {
    tabs: ['product-a.html', 'product-b.html'],
  },
  budget: { expectedSteps: 5, expectedTokens: 8000, expectedDurMs: 5000, maxSteps: 12 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /product[- ]a/i },
      { kind: 'answer-contains', value: /product[- ]b/i },
    ],
    trace: [
      { kind: 'subagent-spawned', minCount: 2 },
    ],
    llm: {
      question: '答案是否清晰对比了两个产品,且选择有理据?',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['subagent', 'synthesis', 'context-isolation', 'capability'],
}
