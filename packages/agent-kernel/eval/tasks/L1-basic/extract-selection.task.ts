import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L1/extract-selection',
  level: 'L1',
  prompt: '总结这段我选中的文本，用一句话。',
  fixtures: { snapshot: 'selection-paragraph.html' },
  budget: { expectedSteps: 1, expectedTokens: 800, expectedDurMs: 3000, maxSteps: 3 },
  judge: {
    completion: [{ kind: 'answer-contains', value: /attention|注意力|transformer/i }],
    trace: [
      { kind: 'tool-called', name: 'readSelection' },
      { kind: 'tool-not-called', name: 'readPage' },
    ],
  },
  tags: ['basic'],
}
