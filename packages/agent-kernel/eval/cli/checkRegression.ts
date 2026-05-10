#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

function loadJson(p: string): any { return JSON.parse(fs.readFileSync(p, 'utf8')) }

function findReportJson(dir: string): string {
  // dir is like ./eval-out/latest — look for report.json directly inside
  const direct = path.join(dir, 'report.json')
  if (fs.existsSync(direct)) return direct
  throw new Error(`No report.json in ${dir}`)
}

function main() {
  const args = process.argv.slice(2)
  let baselinePath = ''
  let currentPath  = ''
  let threshold    = -0.05
  for (const a of args) {
    if (a.startsWith('--baseline=')) baselinePath = a.slice('--baseline='.length)
    else if (a.startsWith('--current=')) currentPath = a.slice('--current='.length)
    else if (a.startsWith('--threshold=')) threshold = Number(a.slice('--threshold='.length))
  }
  if (!baselinePath) baselinePath = 'eval/baseline.json'
  if (!currentPath)  currentPath  = findReportJson('eval-out/latest')
  const base = loadJson(baselinePath)
  const cur  = loadJson(currentPath)
  const delta = cur.meanComposite - base.meanComposite
  console.log(`baseline meanComposite=${base.meanComposite.toFixed(3)}`)
  console.log(`current  meanComposite=${cur.meanComposite.toFixed(3)}`)
  console.log(`delta=${delta.toFixed(3)} threshold=${threshold}`)
  if (delta < threshold) {
    console.error('REGRESSION: meanComposite dropped beyond threshold')
    process.exit(1)
  }
  console.log('OK: no regression')
}
main()
