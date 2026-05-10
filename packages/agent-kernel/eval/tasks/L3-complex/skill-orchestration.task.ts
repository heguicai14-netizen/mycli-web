import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/skill-orchestration',
  level: 'L3',
  prompt:
    '用 summarizePage skill 总结当前页，然后把摘要里出现的人名分别在我打开的另外几个 tab 里查一下他们出现没。',
  fixtures: {
    snapshot: 'article.html',
    tabs: ['multi-tab-context/tab-a.html', 'multi-tab-context/tab-b.html'],
    skills: {
      summarizePage:
        '你是一个网页总结助手。读完页面后，输出 3 句话以内的摘要，列出文中提到的人名。',
    },
  },
  budget: { expectedSteps: 8, expectedTokens: 8000, expectedDurMs: 18000, maxSteps: 14 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: 'Alice' },
      { kind: 'answer-contains', value: 'Bob' },
    ],
    trace: [
      { kind: 'tool-called', name: 'useSkill', argsMatch: { name: 'summarizePage' } },
      { kind: 'tool-called', name: 'listTabs' },
      { kind: 'tool-called', name: 'readPage' },
    ],
    llm: {
      question:
        '是否正确总结了原文（讲 scaling agents），并准确报告 Alice 在 tab A 出现、Bob 在 tab B 出现？',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['complex', 'multi-tool', 'skill'],
}
