import type { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import type { Task, RunTrace, TraceStep } from '../core/types'

function compactTrace(steps: TraceStep[]): string {
  // subagent-spawn steps are not surfaced to the llm-judge prompt in v1.
  const filtered = steps.filter((s) => s.kind !== 'subagent-spawn')
  return filtered.map((s) => {
    if (s.kind === 'assistant-message') return `assistant: ${s.text.slice(0, 200)}`
    if (s.kind === 'tool-call') return `→ ${s.name}(${JSON.stringify(s.args).slice(0, 200)})`
    if (s.kind === 'tool-result') {
      return `← ${s.ok ? 'ok' : 'err'}: ${s.ok ? String(s.data ?? '').slice(0, 100) : (s.error ?? '').slice(0, 100)}`
    }
    return ''
  }).join('\n')
}

const PROMPT = (task: Task, trace: RunTrace) => `
你是 agent 评测官。下面是 agent 任务、用户提问、agent 最终答案、完整工具调用 trace。
请按 rubric 打分。只输出 JSON：{"score": <数字>, "reason": "..."}

[Rubric] ${task.judge.llm!.question}
[Scale]  ${task.judge.llm!.scale === 'pass-fail' ? 'pass-fail (score must be 0 or 5)' : '0-5'}
[Task]   ${task.prompt}
[Answer] ${trace.finalAnswer}
[Trace]
${compactTrace(trace.steps)}
`.trim()

export async function runLlmJudge(
  task: Task,
  trace: RunTrace,
  judgeLLM: Pick<OpenAICompatibleClient, 'streamChat'> | undefined,
): Promise<number | undefined> {
  const rubric = task.judge.llm
  if (!rubric || !judgeLLM) return undefined
  let text = ''
  for await (const ev of judgeLLM.streamChat({
    messages: [{ role: 'user', content: PROMPT(task, trace) }],
  })) {
    if (ev.kind === 'delta') text += ev.text
  }
  const m = text.match(/\{[^{}]*"score"[^{}]*\}/)
  if (!m) return undefined
  try {
    const obj = JSON.parse(m[0]) as { score: number }
    if (typeof obj.score !== 'number') return undefined
    return Math.max(0, Math.min(1, obj.score / 5))
  } catch {
    return undefined
  }
}
