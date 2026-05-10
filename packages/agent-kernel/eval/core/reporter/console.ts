import type { SuiteReport, TaskLevel } from '../types'

const LEVELS: TaskLevel[] = ['L1', 'L2', 'L3']

function bar(ratio: number, width = 12): string {
  const filled = Math.round(ratio * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function pct(n: number, d: number): string {
  if (d === 0) return '  0%'
  const v = Math.round((n / d) * 100)
  return `${String(v).padStart(3)}%`
}

export function renderConsole(r: SuiteReport): string {
  const total = r.totals.passed + r.totals.failed
  const lines: string[] = []
  lines.push(`agent-kernel eval • model=${r.llmModel} • ${total} tasks`)
  lines.push('─'.repeat(45))
  for (const lvl of LEVELS) {
    const lr = r.byLevel[lvl]
    const sum = lr.passed + lr.failed
    if (sum === 0) continue
    lines.push(
      `${lvl}  ${bar(sum === 0 ? 0 : lr.passed / sum)}  ` +
      `${lr.passed}/${sum}  pass=${pct(lr.passed, sum)}  ` +
      `mean=${lr.meanComposite.toFixed(2)}`,
    )
  }
  lines.push('─'.repeat(45))
  lines.push(`TOTAL          ${r.totals.passed}/${total}  pass=${pct(r.totals.passed, total)}  mean=${r.meanComposite.toFixed(2)}`)

  const tagKeys = Object.keys(r.byTag).sort()
  if (tagKeys.length) {
    lines.push('')
    lines.push('By tag:')
    for (const k of tagKeys) {
      const t = r.byTag[k]
      const sum = t.passed + t.failed
      lines.push(`  ${k.padEnd(16)} ${t.passed}/${sum}  mean=${t.meanComposite.toFixed(2)}`)
    }
  }

  const failed = r.tasks.filter((t) => !t.passed)
  if (failed.length) {
    lines.push('')
    lines.push('Failures:')
    for (const t of failed) {
      lines.push(`  ✗ ${t.task.id.padEnd(34)} composite=${t.scores.composite.toFixed(2)}`)
    }
  }
  lines.push('')
  lines.push(
    `Tokens ~${Math.round(r.meanTokens)} avg/task   |   meanSteps=${r.meanSteps.toFixed(1)}`,
  )
  return lines.join('\n')
}
