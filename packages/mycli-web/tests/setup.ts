import 'fake-indexeddb/auto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { installChromeMock } from './mocks/chrome'
import { beforeEach } from 'vitest'

// Load packages/mycli-web/.env into process.env before tests run. Bun does
// auto-load .env, but only from the dir it was launched in — running from
// the workspace root (most common in monorepos) misses it. Vitest also
// spawns its own test runner process. Loading here is the most reliable.
;(function loadDotEnv() {
  try {
    const envPath = path.resolve(__dirname, '..', '.env')
    if (!fs.existsSync(envPath)) return
    const text = fs.readFileSync(envPath, 'utf-8')
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
      if (!m) continue
      const key = m[1]
      // Strip surrounding quotes if present.
      let value = m[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      // Don't override real env (so CI / one-shot prefixes still win).
      if (!process.env[key]) process.env[key] = value
    }
  } catch {
    // .env loading is best-effort; live tests will just stay skipped.
  }
})()

beforeEach(() => {
  installChromeMock()
})
