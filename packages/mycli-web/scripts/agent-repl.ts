// Interactive REPL for poking at agent capabilities against a real LLM.
// Reads creds from ~/test.txt or env vars, gives you a prompt, prints
// streaming output, surfaces tool calls inline. Use it to feel out planning,
// multi-tool orchestration, error recovery, etc.
//
// Run:
//   bun run scripts/agent-repl.ts
//
// Creds resolution (first hit wins per field):
//   1. MYCLI_TEST_API_KEY / MYCLI_TEST_BASE_URL / MYCLI_TEST_MODEL
//   2. ~/test.txt with lines like  url:...  model:...  apiKey:...
//
// Slash commands at the prompt:
//   /exit, /quit             leave
//   /reset                   clear conversation history
//   /tools                   list available tools
//   /system <prompt>         set / replace system prompt for following turns
//   /system!                 clear system prompt
//   /help                    show commands
//
// The default toolset is fetchGet (real HTTP), plus calculator and currentTime
// stubs so you can probe multi-tool decisions without needing a browser.

import readline from 'node:readline/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  createAgent,
  makeOk,
  makeError,
  createUseSkillTool,
  createReadSkillFileTool,
  type ChatMessage,
  type ToolDefinition,
  fetchGetTool,
} from 'agent-kernel'
import { buildRegistryFromModules } from '../src/extension-skills/loader'

interface Creds {
  apiKey: string
  baseUrl: string
  model: string
}

function parseCredsFile(text: string): Partial<Creds> {
  const out: Partial<Creds> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'apikey' || key === 'api_key') out.apiKey = value
    else if (key === 'baseurl' || key === 'base_url' || key === 'url') out.baseUrl = value
    else if (key === 'model') out.model = value
  }
  return out
}

function resolveCreds(): Creds {
  const env = process.env
  const fromEnv: Partial<Creds> = {
    apiKey: env.MYCLI_TEST_API_KEY,
    baseUrl: env.MYCLI_TEST_BASE_URL,
    model: env.MYCLI_TEST_MODEL,
  }
  const credsFile = path.join(os.homedir(), 'test.txt')
  const fromFile: Partial<Creds> = fs.existsSync(credsFile)
    ? parseCredsFile(fs.readFileSync(credsFile, 'utf-8'))
    : {}
  return {
    apiKey: fromEnv.apiKey || fromFile.apiKey || '',
    baseUrl: fromEnv.baseUrl || fromFile.baseUrl || 'https://api.openai.com/v1',
    model: fromEnv.model || fromFile.model || 'gpt-4o-mini',
  }
}

const calculatorTool: ToolDefinition<{ expr: string }, { result: number }, any> = {
  name: 'calculator',
  description:
    'Evaluates a basic arithmetic expression with +, -, *, /, parentheses. ' +
    'Args: { expr: string }. Example: { "expr": "(17 + 23) * 2" }',
  inputSchema: {
    type: 'object',
    properties: { expr: { type: 'string' } },
    required: ['expr'],
    additionalProperties: false,
  },
  execute: async (input) => {
    if (typeof input?.expr !== 'string') {
      return makeError('invalid_input', 'expr must be a string')
    }
    if (!/^[\d+\-*/().\s]+$/.test(input.expr)) {
      return makeError(
        'invalid_expr',
        'Only digits, + - * / ( ) . and spaces are allowed.',
      )
    }
    try {
      // eslint-disable-next-line no-eval
      const result = eval(input.expr) as number
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        return makeError('not_a_number', `evaluated to ${result}`)
      }
      return makeOk({ result })
    } catch (e: any) {
      return makeError('eval_error', e?.message ?? String(e))
    }
  },
}

const currentTimeTool: ToolDefinition<Record<string, never>, { time: string }, any> = {
  name: 'currentTime',
  description: 'Returns the current local time on the server as an ISO 8601 string.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => makeOk({ time: new Date().toISOString() }),
}

// Load bundled skills from disk so the REPL has the same useSkill /
// readSkillFile capability the extension does. Uses the same loader as the
// extension (the part that doesn't touch import.meta.glob), but constructs
// the modules dict via fs at runtime since Bun doesn't run Vite transforms.
function loadSkillsFromDisk() {
  const skillsRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'src',
    'extension-skills',
    'skills',
  )
  const modules: Record<string, string> = {}
  if (!fs.existsSync(skillsRoot)) return buildRegistryFromModules(modules)
  // Recursively walk skillsRoot, mirroring vite's './skills/<name>/<rest>' keying.
  const walk = (dir: string, relPrefix: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.isFile() && ent.name.endsWith('.md')) {
        modules[`./skills/${rel}`] = fs.readFileSync(abs, 'utf-8')
      }
    }
  }
  walk(skillsRoot, '')
  return buildRegistryFromModules(modules)
}

const skillRegistry = loadSkillsFromDisk()
const useSkillTool = createUseSkillTool({ registry: skillRegistry })
const readSkillFileTool = createReadSkillFileTool({ registry: skillRegistry })

const tools: ToolDefinition<any, any, any>[] = [
  fetchGetTool,
  calculatorTool,
  currentTimeTool,
  useSkillTool,
  readSkillFileTool,
]

const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

async function main() {
  const creds = resolveCreds()
  if (!creds.apiKey) {
    console.error(
      ANSI.red(
        'No apiKey. Set MYCLI_TEST_API_KEY or write ~/test.txt with apiKey:/url:/model:',
      ),
    )
    process.exit(1)
  }

  console.log(
    ANSI.dim(
      `[agent-repl] ${creds.baseUrl}  model=${creds.model}  key=…${creds.apiKey.slice(-4)}`,
    ),
  )
  console.log(
    ANSI.dim(
      `[tools] ${tools.map((t) => t.name).join(', ')}    type /help for commands`,
    ),
  )

  const history: ChatMessage[] = []
  let systemPrompt: string | undefined

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  while (true) {
    let line: string
    try {
      line = (await rl.question('\n' + ANSI.bold('› '))).trim()
    } catch {
      break
    }
    if (!line) continue

    // Slash commands.
    if (line === '/exit' || line === '/quit') break
    if (line === '/reset') {
      history.length = 0
      console.log(ANSI.dim('[history cleared]'))
      continue
    }
    if (line === '/tools') {
      for (const t of tools) {
        console.log(`  ${ANSI.cyan(t.name)} — ${t.description}`)
      }
      continue
    }
    if (line === '/system!') {
      systemPrompt = undefined
      console.log(ANSI.dim('[system prompt cleared]'))
      continue
    }
    if (line.startsWith('/system ')) {
      systemPrompt = line.slice('/system '.length).trim()
      console.log(ANSI.dim(`[system prompt set: ${systemPrompt}]`))
      continue
    }
    if (line === '/help' || line === '?') {
      console.log(
        '  /exit /quit       leave\n' +
          '  /reset            clear conversation history\n' +
          '  /tools            list available tools\n' +
          '  /system <text>    set system prompt\n' +
          '  /system!          clear system prompt\n' +
          '  /help             show this',
      )
      continue
    }

    // Run one turn.
    const agent = createAgent({
      llm: creds,
      tools,
      toolContext: {},
      systemPrompt,
      toolMaxIterations: 10,
    })

    let assistantText = ''
    let printingAssistant = false
    const turnStart = Date.now()

    try {
      for await (const ev of agent.send(line, { history })) {
        if (ev.kind === 'message/streamChunk') {
          if (!printingAssistant) {
            process.stdout.write('\n' + ANSI.green('● ') + ANSI.bold('') )
            printingAssistant = true
          }
          process.stdout.write(ev.delta)
          assistantText += ev.delta
        } else if (ev.kind === 'tool/start') {
          if (printingAssistant) {
            process.stdout.write('\n')
            printingAssistant = false
          }
          const args = JSON.stringify(ev.toolCall.args)
          console.log(
            ANSI.cyan(`▸ ${ev.toolCall.tool}`) +
              ANSI.dim(` ${args.length > 200 ? args.slice(0, 200) + '…' : args}`),
          )
        } else if (ev.kind === 'tool/end') {
          const r = ev.result as any
          if (r.ok) {
            const content = (r.content as string | undefined) ?? ''
            const preview =
              content.length > 200 ? content.slice(0, 200) + '…' : content
            console.log(ANSI.green('  ✓ ') + ANSI.dim(preview))
          } else {
            console.log(
              ANSI.red('  ✗ ') +
                ANSI.dim(`${r.error?.code ?? 'error'}: ${r.error?.message ?? ''}`),
            )
          }
        } else if (ev.kind === 'done') {
          if (printingAssistant) process.stdout.write('\n')
          const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1)
          if (ev.stopReason !== 'end_turn') {
            console.log(
              ANSI.dim(`[stop=${ev.stopReason} ${elapsed}s]`) +
                (ev.error
                  ? ' ' + ANSI.red(`${ev.error.code}: ${ev.error.message}`)
                  : ''),
            )
          } else {
            console.log(ANSI.dim(`[${elapsed}s]`))
          }
          history.push({ role: 'user', content: line })
          history.push({ role: 'assistant', content: assistantText })
        }
      }
    } catch (e: any) {
      console.error(ANSI.red(`\n[turn error] ${e?.message ?? String(e)}`))
    }
  }

  rl.close()
  console.log(ANSI.dim('bye'))
}

main().catch((e) => {
  console.error(ANSI.red(`[fatal] ${e?.message ?? String(e)}`))
  process.exit(1)
})
