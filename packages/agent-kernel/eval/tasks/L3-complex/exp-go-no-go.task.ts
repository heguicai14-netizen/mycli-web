import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/exp-go-no-go',
  level: 'L3',
  prompt:
    '我准备决定实验 12345 要不要放量。先看一下它本身的数据，再跟最近 3 个同类实验（首页推荐方向）对比，最后给我一个 go / no-go 的结论，要带理由。',
  fixtures: {
    tabs: ['exp-dashboard-12345.html'],
    fetchMap: {
      'https://exp.internal/api/exp/12345': JSON.stringify({
        name: '首页推荐改版 v3',
        treatment: { ctr: 0.0921, gmv_per_user: 13.85 },
        control:   { ctr: 0.0843, gmv_per_user: 12.43 },
        stat_sig:  { ctr: true, gmv_per_user: true },
      }),
      'https://exp.internal/api/exp/list?topic=home-rec&limit=3': JSON.stringify([
        { id: 11201, result: 'shipped',      lift_gmv:  0.072 },
        { id: 11455, result: 'shipped',      lift_gmv:  0.058 },
        { id: 11890, result: 'rolled_back',  lift_gmv: -0.012 },
      ]),
      'https://exp.internal/api/exp/11201': JSON.stringify({ name: 'rec v1', lift_gmv: 0.072 }),
      'https://exp.internal/api/exp/11455': JSON.stringify({ name: 'rec v2', lift_gmv: 0.058 }),
      'https://exp.internal/api/exp/11890': { body: '', status: 500, failOnce: false },
    },
  },
  budget: { expectedSteps: 12, expectedTokens: 12000, expectedDurMs: 25000, maxSteps: 20 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /go|放量|上线|不放量|no.?go|回滚/i },
      // Must reference at least one historical experiment id explicitly
      { kind: 'answer-contains', value: /11201|11455/ },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /exp\/12345$/ } },
      { kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /list\?topic=home-rec/ } },
      // Don't retry the failing 11890 endpoint more than once
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
    llm: {
      question:
        '结论是否引用了当前实验+至少一个历史实验数据？是否如实标注 11890 缺失而不是编造数据？建议在 ctr/gmv 双显著、且历史 lift_gmv ~6-7% 的语境下是否合理（应倾向 go）？',
      scale: '0-5',
      weight: 2,
    },
  },
  tags: ['complex', 'data-analysis', 'multi-tool', 'decomposition', 'recovery'],
}
