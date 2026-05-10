import type { Task } from '../../core/types'
export const task: Task = {
  id: 'L2/exp-treatment-readout',
  level: 'L2',
  prompt:
    '拿 https://exp.internal/api/exp/12345 的实验数据，告诉我 treatment 组相对 control 组哪些指标显著上涨、哪些下跌，最后给我一个是否放量的建议。',
  fixtures: {
    fetchMap: {
      'https://exp.internal/api/exp/12345': JSON.stringify({
        name: '首页推荐改版 v3',
        duration_days: 7,
        control:   { samples: 102345, ctr: 0.0843, cvr: 0.0231, gmv_per_user: 12.43, stay_sec: 38.2 },
        treatment: { samples: 102881, ctr: 0.0921, cvr: 0.0227, gmv_per_user: 13.85, stay_sec: 41.6 },
        stat_sig:  { ctr: true, cvr: false, gmv_per_user: true, stay_sec: true },
      }),
    },
  },
  budget: { expectedSteps: 4, expectedTokens: 4500, expectedDurMs: 8000, maxSteps: 8 },
  judge: {
    completion: [
      { kind: 'answer-contains', value: /ctr|点击/i },
      { kind: 'answer-contains', value: /gmv/i },
      { kind: 'answer-contains', value: /放量|上线|建议|不建议/ },
    ],
    trace: [
      { kind: 'tool-called', name: 'fetchGet', argsMatch: { url: /exp\/12345$/ } },
      { kind: 'max-redundant-calls', name: 'fetchGet', max: 1 },
    ],
    llm: {
      question:
        '是否正确识别 ctr↑显著、gmv↑显著、cvr 不显著、stay 显著上涨？最终建议是否合理（应支持放量）？',
      scale: '0-5',
      weight: 1.5,
    },
  },
  tags: ['chain', 'data-analysis'],
}
