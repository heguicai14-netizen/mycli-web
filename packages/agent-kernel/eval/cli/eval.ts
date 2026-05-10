#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OpenAICompatibleClient } from '../../src/core/OpenAICompatibleClient'
import { runEvalCore } from '../core/runEval'
import { wrapForRecord } from '../replay/recorder'
import { wrapForReplay, makeFsReplayStore, makeFsRecordStore } from '../replay/player'
import { renderConsole } from '../core/reporter/console'
import { renderJson } from '../core/reporter/json'
import { renderMarkdown } from '../core/reporter/markdown'
import { filterSuite, smokeIds } from '../tasks/index'
import type { Suite } from '../core/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface ConfigModule {
  default: {
    llm: any; judgeLLM?: any; suite: Suite;
    reporter: ('console'|'markdown'|'json')[]; outDir: string;
  }
}

function parseArgs(argv: string[]) {
  const opts: { filter?: string; record?: boolean; replayFrom?: string; smoke?: boolean } = {}
  for (const a of argv) {
    if (a === '--record') opts.record = true
    else if (a === '--smoke') opts.smoke = true
    else if (a.startsWith('--filter=')) opts.filter = a.slice('--filter='.length)
    else if (a.startsWith('--replay-from=')) opts.replayFrom = a.slice('--replay-from='.length)
  }
  return opts
}

function buildFilter(s: string | undefined, smoke: boolean): { levels?: any[]; tags?: string[]; ids?: string[] } | undefined {
  if (smoke) return { ids: smokeIds }
  if (!s) return undefined
  if (s.startsWith('id:'))   return { ids:    [s.slice(3)] }
  if (s.startsWith('tag:'))  return { tags:   [s.slice(4)] }
  if (s === 'L1' || s === 'L2' || s === 'L3') return { levels: [s] }
  return undefined
}

async function main() {
  const cwd = process.cwd()
  const configPath = path.join(cwd, 'eval-config.ts')
  if (!fs.existsSync(configPath)) {
    console.error(`No eval-config.ts in ${cwd}`)
    process.exit(2)
  }
  const cfg = (await import(configPath)) as ConfigModule
  const c = cfg.default
  const args = parseArgs(process.argv.slice(2))

  const tasks = filterSuite(c.suite, buildFilter(args.filter, args.smoke ?? false))
  if (tasks.length === 0) { console.error('No tasks matched filter'); process.exit(1) }

  const baseLlm = new OpenAICompatibleClient(c.llm)

  let wrapLlmForTask: ((taskId: string, llm: any) => any) | undefined
  if (args.record) {
    const dir = path.join(c.outDir, 'replay', `${c.llm.model}-${new Date().toISOString().slice(0, 10)}`)
    const store = makeFsRecordStore(dir)
    wrapLlmForTask = (taskId, baseLlmInner) => wrapForRecord(baseLlmInner, taskId, store)
  } else if (args.replayFrom) {
    const store = makeFsReplayStore(args.replayFrom)
    wrapLlmForTask = (taskId, _baseLlm) => wrapForReplay(taskId, store)
  }

  const judgeLLM = c.judgeLLM ? new OpenAICompatibleClient(c.judgeLLM) : undefined

  const snapshotDir = path.join(__dirname, '..', 'fixtures', 'snapshots')
  const report = await runEvalCore({
    tasks, llm: baseLlm, judgeLLM, snapshotDir, wrapLlmForTask,
  })
  report.llmModel = c.llm.model

  fs.mkdirSync(c.outDir, { recursive: true })
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${c.llm.model}`
  const subdir = path.join(c.outDir, stamp)
  fs.mkdirSync(subdir, { recursive: true })
  for (const r of c.reporter) {
    if (r === 'console') console.log(renderConsole(report))
    if (r === 'markdown') fs.writeFileSync(path.join(subdir, 'report.md'),  renderMarkdown(report))
    if (r === 'json')     fs.writeFileSync(path.join(subdir, 'report.json'), renderJson(report))
  }
  // 'latest' symlink
  const latest = path.join(c.outDir, 'latest')
  try { fs.unlinkSync(latest) } catch {}
  try { fs.symlinkSync(stamp, latest, 'dir') } catch {}

  // Exit non-zero if any failed (so smoke can fail CI)
  process.exit(report.totals.failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
