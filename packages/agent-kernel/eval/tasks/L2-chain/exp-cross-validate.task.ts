import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/exp-cross-validate',
  level: 'L2',
  prompt:
    '我打开了一个实验后台 tab，同时这个实验在 API 上也能查。帮我比一下 API 数据和后台页面显示的数据是不是一致，不一致就指出哪条对不上。',
  fixtures: {
    snapshot: 'exp-dashboard-12345.html',
    tabs: ['exp-dashboard-12345.html'],
    fetchMap: {
      'https://exp.internal/api/exp/12345': JSON.stringify({
        name: '首页推荐改版 v3',
        control:   { ctr: 0.0843, cvr: 0.0231, gmv_per_user: 12.43, stay_sec: 38.2 },
        treatment: { ctr: 0.0921, cvr: 0.0227, gmv_per_user: 13.85, stay_sec: 41.6 },
      }),
    },
  },
  budget: { expectedSteps: 6, expectedTokens: 5500, expectedDurMs: 12000, maxSteps: 10 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /gmv/i },
      { kind: 'answer-contains', value: '13.85' },
      { kind: 'answer-contains', value: '13.50' },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet' },
      { kind: 'tool-called', name: 'readPage' },
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
      { kind: 'max-redundant-calls', name: 'readPage', max: 1 },
    ],
    llm: {
      question:
        '是否准确指出 gmv_per_user 在 API (13.85) 与 dashboard (13.50) 不一致？是否未对其他指标报假阳性？',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['chain', 'data-analysis', 'multi-tool', 'cross-source'],
}
