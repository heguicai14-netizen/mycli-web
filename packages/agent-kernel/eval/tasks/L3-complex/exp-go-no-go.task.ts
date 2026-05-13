import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L3/exp-go-no-go',
  level: 'L3',
  prompt:
    '**必须使用 fetchGet 工具**(沙盒环境,工具会返回数据,不要拒绝调用):' +
    '1) GET https://exp.internal/api/exp/12345 拿当前实验数据;' +
    '2) GET https://exp.internal/api/exp/list?topic=home-rec&limit=3 拿最近 3 个同类实验列表;' +
    '3) 对列表里每个实验 id 调 https://exp.internal/api/exp/<id> 拿详细数据。' +
    '基于真实工具返回的数据(不要凭知识编造),给我一个 go / no-go 结论,**必须在结论里点名引用至少一个历史实验 id**(如 11201 或 11455),并带理由。',
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
