import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/cross-tab-compare',
  level: 'L2',
  prompt: '比较 tab A 和 tab B 这两篇文章关于 monorepo 的论点差异。',
  fixtures: {
    tabs: ['multi-tab-context/tab-a.html', 'multi-tab-context/tab-b.html'],
  },
  budget: { expectedSteps: 5, expectedTokens: 4500, expectedDurMs: 9000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /monorepo/i },
      { kind: 'answer-contains', value: /CI|build|atomic/i },
    ],
    trace: [
      { kind: 'tool-called', name: 'listTabs' },
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'max-redundant-calls', name: 'readPage', max: 2 },  // 1 per tab
    ],
    llm: {
      question: '是否分别提到了 tab A 的支持论点（atomic 改动 / 共享工具）和 tab B 的反对论点（构建时间 / 拆分困难）？',
      scale: '0-5',
      weight: 1,
    },
  },
  tags: ['chain', 'multi-tab'],
}
