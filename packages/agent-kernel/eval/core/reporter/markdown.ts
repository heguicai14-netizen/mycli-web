import type { SuiteReport, TaskReport, TraceStep, TaskLevel } from '../types'

const LEVELS: TaskLevel[] = ['L1', 'L2', 'L3', 'L4']

function summaryTable(r: SuiteReport): string {
  const rows = LEVELS.flatMap((lvl) => {
    const x = r.byLevel[lvl]
    if (!x) return []
    const sum = x.passed + x.failed
    return [`| ${lvl} | ${x.passed}/${sum} | ${x.meanComposite.toFixed(2)} |`]
  })
  return [
    `| Level | Passed | Mean composite |`,
    `|---|---|---|`,
    ...rows,
  ].join('\n')
}

function renderTrace(steps: TraceStep[]): string {
  // subagent-spawn steps are not rendered in v1 markdown — kept in the trace
  // for judge consumption only.
  const filtered = steps.filter((s) => s.kind !== 'subagent-spawn')
  return filtered.map((s, i) => {
    const n = String(i + 1).padStart(2)
    if (s.kind === 'assistant-message') return `${n}. assistant: ${truncate(s.text, 200)}`
    if (s.kind === 'tool-call') return `${n}. tool-call  ${s.name}(${JSON.stringify(s.args)})`
    if (s.kind === 'tool-result') {
      return `${n}. tool-result ok=${s.ok}` +
        (s.ok ? ` → ${truncate(String(s.data ?? ''), 120)}` : ` ✗ ${truncate(s.error ?? '', 120)}`)
    }
    return ''
  }).join('\n')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function taskSection(t: TaskReport): string {
  const status = t.passed ? '✅' : '❌'
  const lines = [
    `## ${t.task.id} ${status}`,
    '',
    `**Prompt:** ${t.task.prompt}`,
    '',
    `**Scores:** completion=${t.scores.completion.toFixed(2)} ` +
    `trace=${t.scores.traceQuality.toFixed(2)} ` +
    `efficiency=${t.scores.efficiency.toFixed(2)} ` +
    `**composite=${t.scores.composite.toFixed(2)}**`,
    '',
    `**Tokens:** in=${t.trace.tokensIn} out=${t.trace.tokensOut} ` +
    `**Duration:** ${t.trace.durationMs}ms`,
    '',
  ]
  if (t.failures.length) {
    lines.push('**Failures:**', '')
    for (const f of t.failures) lines.push(`- ✗ ${f}`)
    lines.push('')
  }
  lines.push('**Final answer:**', '', '```', truncate(t.trace.finalAnswer, 1000), '```', '')
  lines.push('**Trace:**', '', '```', renderTrace(t.trace.steps), '```', '')
  return lines.join('\n')
}

export function renderMarkdown(r: SuiteReport): string {
  const total = r.totals.passed + r.totals.failed
  return [
    `# agent-kernel eval — ${r.startedAt}`,
    '',
    `Model: \`${r.llmModel}\`   |   ${r.totals.passed}/${total} passed   |   ` +
    `mean composite: **${r.meanComposite.toFixed(2)}**`,
    '',
    summaryTable(r),
    '',
    '---',
    '',
    ...r.tasks.map(taskSection),
  ].join('\n')
}
