# Agent Kernel Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the agent loop, browser RPC, skill protocol, and SW/offscreen plumbing into a standalone `agent-kernel` package inside a Bun workspace; demote current mycli-web to a reference consumer that depends on the kernel.

**Architecture:** Two-package workspace (`packages/agent-kernel/` + `packages/mycli-web/`). Kernel exports assembly-kit helpers (`installKernelBackground`, `bootKernelOffscreen`, `createAgentClient`) and three adapter interfaces (`SettingsAdapter`, `MessageStoreAdapter`, `ToolContextBuilder`). Migration is incremental — every commit leaves mycli-web building, type-checking, and passing all existing tests.

**Tech Stack:** Bun ≥ 1.3.5, Bun workspaces, TypeScript project references, Vite + @crxjs (in mycli-web only), Vitest, jsdom + node test envs.

**Spec:** [`docs/superpowers/specs/2026-05-10-agent-kernel-extraction-design.md`](../specs/2026-05-10-agent-kernel-extraction-design.md)

**Migration safety rule:** Every task ends with the equivalent of `bun run typecheck && bun run test && bun run build` succeeding from the workspace root. If any task can't satisfy that, STOP and escalate.

---

## Phase 1 — Workspace + module extraction (8 tasks)

### Task 1: Create Bun workspace + move current sources into `packages/mycli-web/`

**Files:**
- Modify: `package.json` (root) — convert to workspace root
- Move: everything currently under root `src/`, `scripts/`, `tests/`, `manifest.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.base.json`, `html/`, `public/`, `postcss.config.js`, `tailwind.config.js`, `tsconfig.test.json` → into `packages/mycli-web/` (preserving subpaths)
- Keep at root: `package.json` (now workspace root), `bun.lock`, `docs/`, `.gitignore`, `CLAUDE.md`, `README.md`, `.claude/`, `.claire/`, `.obsidian/`

This is the one big atomic shuffle. After it, every later task is small.

- [ ] **Step 1: Mkdir + git mv current project into `packages/mycli-web/`**

```bash
cd /Users/heguicai/myProject/mycli-web
mkdir -p packages/mycli-web
git mv src packages/mycli-web/src
git mv scripts packages/mycli-web/scripts
git mv tests packages/mycli-web/tests
git mv html packages/mycli-web/html
git mv public packages/mycli-web/public
git mv manifest.json packages/mycli-web/manifest.json
git mv vite.config.ts packages/mycli-web/vite.config.ts
git mv vitest.config.ts packages/mycli-web/vitest.config.ts
git mv tsconfig.test.json packages/mycli-web/tsconfig.test.json
git mv postcss.config.js packages/mycli-web/postcss.config.js
git mv tailwind.config.js packages/mycli-web/tailwind.config.js
```

- [ ] **Step 2: Move tsconfig files**

`tsconfig.base.json` and `tsconfig.json` need to live in BOTH the root (for workspace-wide tooling) AND inside `packages/mycli-web/` (the consumer's own TS config). Strategy: copy `tsconfig.base.json` to root keep it unchanged for now; move `tsconfig.json` to `packages/mycli-web/tsconfig.json` and create a new minimal root `tsconfig.json`.

```bash
cp tsconfig.base.json packages/mycli-web/tsconfig.base.json
git mv tsconfig.json packages/mycli-web/tsconfig.json
```

Then create new root `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/mycli-web" }
  ]
}
```

(`packages/agent-kernel` will be added in Task 2.)

- [ ] **Step 3: Create the new root `package.json` (workspace root)**

Replace root `package.json` content with:

```json
{
  "name": "mycli-web-workspace",
  "version": "0.0.0",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "cd packages/mycli-web && bun run build",
    "dev": "cd packages/mycli-web && bun run dev",
    "test": "bun test --cwd packages/mycli-web && bun test --cwd packages/agent-kernel || true",
    "typecheck": "tsc -b"
  }
}
```

The `|| true` on agent-kernel test guards against the early phase where its tests directory is empty.

- [ ] **Step 4: Move the original `package.json` content into `packages/mycli-web/package.json`**

Take what was the root `package.json` (the build/test/typecheck scripts and dependencies) and put it at `packages/mycli-web/package.json`. Keep `name` as `"mycli-web"`. Strip the `engines` field (it can move up to root if you prefer; doesn't matter for correctness).

The exact content (verify against current root package.json before overwriting):

```json
{
  "name": "mycli-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Chrome MV3 browser-agent extension (mycli web port).",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "agent:repl": "bun run scripts/agent-repl.ts"
  },
  "dependencies": {
    "idb": "^8.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^10.1.0",
    "remark-gfm": "^4.0.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.25",
    "@testing-library/react": "^16.0.0",
    "@types/chrome": "^0.0.270",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^24.1.0",
    "postcss": "^8.4.39",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.5.3",
    "vite": "^5.3.3",
    "vitest": "^2.0.2"
  }
}
```

- [ ] **Step 5: Run `bun install` from the workspace root**

```bash
cd /Users/heguicai/myProject/mycli-web
bun install
```

Expected: re-resolves with workspace layout. New `node_modules/` symlinks for workspace packages.

- [ ] **Step 6: Verify build still works inside the workspace**

```bash
cd packages/mycli-web
bun run typecheck
bun run test
bun run build
```

Expected: typecheck clean (the project references inside `tsconfig.json` reference `../../...` paths that need fixing — see Step 7).

- [ ] **Step 7: Fix relative paths in `packages/mycli-web/tsconfig.json` and the per-subproject tsconfigs**

The previous root `tsconfig.json` had:

```json
{
  "files": [],
  "references": [
    { "path": "./src/agent-core" },
    { "path": "./src/extension-tools" },
    { "path": "./src/extension-skills" },
    { "path": "./src/extension" },
    { "path": "./tests" }
  ]
}
```

After move it's now `packages/mycli-web/tsconfig.json`. Same content works (relative paths are still relative to `packages/mycli-web/`). Verify by running typecheck again.

Inside `packages/mycli-web/src/extension/tsconfig.json`, the `extends` field is `"../../tsconfig.base.json"`. After the move, that resolves to `packages/mycli-web/tsconfig.base.json` — which we created in Step 2. 

Inside `packages/mycli-web/tests/tsconfig.json`, same `extends` — same fix applies.

- [ ] **Step 8: Re-verify all checks**

```bash
cd packages/mycli-web
bun run typecheck    # PASS
bun run test          # PASS — 133 tests
bun run build         # PASS

cd ../..              # back to workspace root
bun run typecheck     # PASS
```

If any FAIL, fix the path issue and retry. Don't proceed until all green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: move project into packages/mycli-web for workspace setup"
```

---

### Task 2: Scaffold `packages/agent-kernel/` empty package

**Files:**
- Create: `packages/agent-kernel/package.json`
- Create: `packages/agent-kernel/tsconfig.json`
- Create: `packages/agent-kernel/src/index.ts` (empty placeholder)
- Create: `packages/agent-kernel/tests/.gitkeep`
- Modify: `tsconfig.json` (root) — add reference to agent-kernel
- Modify: `packages/mycli-web/package.json` — add workspace dep

- [ ] **Step 1: Create `packages/agent-kernel/package.json`**

```json
{
  "name": "agent-kernel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Reusable agent kernel for Chrome MV3 extensions.",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b"
  },
  "devDependencies": {
    "vitest": "^2.0.2",
    "typescript": "^5.5.3"
  }
}
```

`main`/`types`/`exports` point at `src/index.ts` directly because we're not building dist for internal workspace use — Vite handles bundling on the consumer side via project references.

- [ ] **Step 2: Create `packages/agent-kernel/tsconfig.json`**

```json
{
  "extends": "../mycli-web/tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "../../node_modules/.cache/tsc/agent-kernel",
    "tsBuildInfoFile": "../../node_modules/.cache/tsc/agent-kernel.tsbuildinfo",
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

(For now we extend mycli-web's tsconfig.base.json. In a follow-up task we'll move the base into the workspace root.)

- [ ] **Step 3: Create empty `packages/agent-kernel/src/index.ts`**

```ts
// Public API entry. Re-exports added per-task as modules migrate in.
export {}
```

- [ ] **Step 4: Create `packages/agent-kernel/tests/.gitkeep`**

```bash
mkdir -p packages/agent-kernel/tests
touch packages/agent-kernel/tests/.gitkeep
```

- [ ] **Step 5: Add the project reference at root**

Edit root `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/agent-kernel" },
    { "path": "./packages/mycli-web" }
  ]
}
```

- [ ] **Step 6: Wire mycli-web to depend on agent-kernel**

Edit `packages/mycli-web/package.json` — add to `dependencies`:

```json
"agent-kernel": "workspace:*"
```

Run `bun install` from root to materialize.

- [ ] **Step 7: Verify**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck    # PASS — both packages compile
bun --cwd packages/mycli-web run test    # PASS — 133 tests
bun --cwd packages/mycli-web run build   # PASS
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold packages/agent-kernel + workspace dep wiring"
```

---

### Task 3: Extract `agent-core/` into the kernel package

**Files:**
- Move: `packages/mycli-web/src/agent-core/` → `packages/agent-kernel/src/core/`
- Move: `packages/mycli-web/tests/agent-core/` → `packages/agent-kernel/tests/core/`
- Modify: `packages/mycli-web/tsconfig.base.json` — repoint `@core` aliases
- Modify: `packages/mycli-web/vite.config.ts` — repoint `@core` aliases
- Modify: `packages/mycli-web/vitest.config.ts` — repoint `@core` aliases
- Modify: `packages/agent-kernel/src/index.ts` — re-export from `./core`
- Delete: `packages/mycli-web/src/agent-core/tsconfig.json` (it's gone with the move)
- Modify: `packages/mycli-web/src/extension-tools/tsconfig.json` — references update
- Modify: `packages/mycli-web/src/extension/tsconfig.json` — references update
- Modify: `packages/mycli-web/tsconfig.json` (consumer) — drop the `agent-core` reference
- Modify: `packages/mycli-web/tests/tsconfig.json` — drop the `agent-core` reference

- [ ] **Step 1: Move source + tests**

```bash
cd /Users/heguicai/myProject/mycli-web
git mv packages/mycli-web/src/agent-core packages/agent-kernel/src/core
git mv packages/mycli-web/tests/agent-core packages/agent-kernel/tests/core
```

The moved `tsconfig.json` inside `agent-core/` comes along — delete it (kernel uses its own at `packages/agent-kernel/tsconfig.json`):

```bash
rm packages/agent-kernel/src/core/tsconfig.json
```

- [ ] **Step 2: Update `packages/agent-kernel/src/index.ts` to re-export everything that was in agent-core**

Read what `packages/agent-kernel/src/core/index.ts` exports today and mirror it. Final content:

```ts
// === core: agent loop & 协议（平台无关）===
export { createAgent, type CreateAgentOptions } from './core/createAgent'
export { AgentSession } from './core/AgentSession'
export {
  OpenAICompatibleClient,
  type ChatMessage,
  type StreamEvent,
} from './core/OpenAICompatibleClient'
export { QueryEngine, type EngineEvent } from './core/QueryEngine'
export { ToolRegistry } from './core/ToolRegistry'
export { toOpenAiTool, makeOk, makeError } from './core/Tool'
export { fetchGetTool } from './core/tools/fetchGet'
export { AgentEvent } from './core/protocol'
export type {
  ToolDefinition,
  ToolExecContext,
  ToolResult,
  ToolCall,
  ToolCallId,
  ConversationId,
  MessageId,
  SkillId,
  ApprovalId,
  Uuid,
  Role,
  Message,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  ContentPart,
} from './core/types'

// === skills (re-exported from current core/index.ts, will move to ./skills in Task 6) ===
export { parseSkillMd, type SkillDefinition, type ParsedSkillMd } from './core/Skill'
export { SkillRegistry } from './core/SkillRegistry'
export { createUseSkillTool } from './core/useSkillTool'
export { createReadSkillFileTool } from './core/readSkillFileTool'
```

- [ ] **Step 3: Update `packages/mycli-web/tsconfig.base.json` — drop `@core` paths**

The `@core` path alias used to point to `./src/agent-core`. Now mycli-web should import from the workspace dep `agent-kernel` instead. Remove the `@core` and `@core/*` entries from the `paths` block:

Final `paths` block:

```json
"paths": {
  "@/*": ["./src/*"],
  "@ext/*": ["./src/extension/*"],
  "@ext-tools": ["./src/extension-tools/index.ts"],
  "@ext-tools/*": ["./src/extension-tools/*"],
  "@ext-skills": ["./src/extension-skills/index.ts"],
  "@ext-skills/*": ["./src/extension-skills/*"]
}
```

(Keep the rest as-is.)

- [ ] **Step 4: Update `packages/mycli-web/vite.config.ts` — drop `@core` aliases**

Final `alias`:

```ts
alias: {
  '@': path.resolve(__dirname, 'src'),
  '@ext': path.resolve(__dirname, 'src/extension'),
  '@ext-tools': path.resolve(__dirname, 'src/extension-tools'),
  '@ext-skills': path.resolve(__dirname, 'src/extension-skills'),
}
```

- [ ] **Step 5: Update `packages/mycli-web/vitest.config.ts` — drop `@core` aliases**

Same as Step 4.

- [ ] **Step 6: Replace every `'@core'` and `'@core/...'` import in mycli-web with `'agent-kernel'`**

```bash
cd packages/mycli-web
# Find all imports
grep -rn "from '@core'\|from \"@core\"\|from '@core/" src tests scripts
```

For each match, edit the file and change `from '@core'` → `from 'agent-kernel'`. For `from '@core/tools/fetchGet'` → `from 'agent-kernel'` (we're re-exporting fetchGetTool from kernel root).

You will see imports in (approximately):
- `src/extension/agentService.ts`
- `src/extension/offscreen.ts` (already imports via relative path inside mycli-web — leave those alone)
- `src/extension/agent-client/index.ts`
- `src/extension-tools/index.ts`
- `src/extension-tools/tools/*.ts`
- `src/extension-skills/loader.ts`
- `src/extension-skills/index.ts`
- `tests/agent/agentService.test.ts`
- `tests/agent-client/agentClient.test.ts`
- `tests/integration/agent.live.test.ts`
- `tests/extension-skills/*.ts`
- `tests/tools/*.ts`
- `scripts/agent-repl.ts` — also change `from '../src/agent-core'` and `from '../src/agent-core/tools/fetchGet'` to `from 'agent-kernel'`

Worked example — `tests/agent/agentService.test.ts`:

```ts
// Before:
import type { AgentEvent as CoreAgentEvent, ToolDefinition } from '@core'

// After:
import type { CoreAgentEvent, ToolDefinition } from 'agent-kernel'
```

Wait — the kernel re-exports `AgentEvent` (from core/protocol.ts) under that name, but mycli-web's protocol also has `AgentEvent`. To avoid collision, kernel exports core protocol's AgentEvent as `CoreAgentEvent` from index.ts. Adjust as needed: rename the import to whatever was used in code. The simple replacement `'@core'` → `'agent-kernel'` should be enough since the symbol names are unchanged.

- [ ] **Step 7: Update `packages/mycli-web/tsconfig.json` references**

Drop `{ "path": "./src/agent-core" }`:

```json
{
  "files": [],
  "references": [
    { "path": "./src/extension-tools" },
    { "path": "./src/extension-skills" },
    { "path": "./src/extension" },
    { "path": "./tests" }
  ]
}
```

- [ ] **Step 8: Update `packages/mycli-web/src/extension/tsconfig.json` references**

Drop `{ "path": "../agent-core" }`. Final `references`:

```json
"references": [
  { "path": "../extension-tools" },
  { "path": "../extension-skills" }
]
```

- [ ] **Step 9: Update `packages/mycli-web/src/extension-tools/tsconfig.json` references**

Drop `{ "path": "../agent-core" }`. Final:

```json
"references": []
```

- [ ] **Step 10: Update `packages/mycli-web/tests/tsconfig.json` references**

Drop `{ "path": "../src/agent-core" }`. Final:

```json
"references": [
  { "path": "../src/extension-tools" },
  { "path": "../src/extension-skills" },
  { "path": "../src/extension" }
]
```

- [ ] **Step 11: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck                            # PASS
bun --cwd packages/mycli-web run test         # PASS — 133 tests
bun --cwd packages/mycli-web run build        # PASS
```

If a test fails because of an import name mismatch, grep the error for the symbol and fix the import in the test file.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: extract agent-core into agent-kernel package"
```

---

### Task 4: Move the skill protocol files (`Skill`, `SkillRegistry`, parsers, tools) into `agent-kernel/src/skills/`

**Files:**
- Move: `packages/agent-kernel/src/core/Skill.ts` → `packages/agent-kernel/src/skills/Skill.ts`
- Move: `packages/agent-kernel/src/core/SkillRegistry.ts` → `packages/agent-kernel/src/skills/SkillRegistry.ts`
- Move: `packages/agent-kernel/src/core/useSkillTool.ts` → `packages/agent-kernel/src/skills/useSkillTool.ts`
- Move: `packages/agent-kernel/src/core/readSkillFileTool.ts` → `packages/agent-kernel/src/skills/readSkillFileTool.ts`
- Move test files similarly: `tests/core/parseSkillMd.test.ts` → `tests/skills/parseSkillMd.test.ts`, etc. (4 files)
- Modify: `packages/agent-kernel/src/index.ts` — repoint skills exports
- Update: any internal imports inside the moved files (they used to import from `'./types'` etc. — now they're one level deeper)

- [ ] **Step 1: Move the files**

```bash
cd /Users/heguicai/myProject/mycli-web
mkdir -p packages/agent-kernel/src/skills
mkdir -p packages/agent-kernel/tests/skills
git mv packages/agent-kernel/src/core/Skill.ts packages/agent-kernel/src/skills/Skill.ts
git mv packages/agent-kernel/src/core/SkillRegistry.ts packages/agent-kernel/src/skills/SkillRegistry.ts
git mv packages/agent-kernel/src/core/useSkillTool.ts packages/agent-kernel/src/skills/useSkillTool.ts
git mv packages/agent-kernel/src/core/readSkillFileTool.ts packages/agent-kernel/src/skills/readSkillFileTool.ts
git mv packages/agent-kernel/tests/core/parseSkillMd.test.ts packages/agent-kernel/tests/skills/parseSkillMd.test.ts
git mv packages/agent-kernel/tests/core/skillRegistry.test.ts packages/agent-kernel/tests/skills/skillRegistry.test.ts
git mv packages/agent-kernel/tests/core/useSkillTool.test.ts packages/agent-kernel/tests/skills/useSkillTool.test.ts
git mv packages/agent-kernel/tests/core/readSkillFileTool.test.ts packages/agent-kernel/tests/skills/readSkillFileTool.test.ts
```

- [ ] **Step 2: Fix imports inside moved files**

Each moved file imported things like `from './types'`, `from './Tool'`. Now those targets live in `../core/`. Edit:

`packages/agent-kernel/src/skills/SkillRegistry.ts`:
```ts
// Before:
import type { SkillDefinition } from './Skill'
// After: unchanged (same dir)
```

`packages/agent-kernel/src/skills/useSkillTool.ts`:
```ts
// Before:
import type { ToolDefinition } from './types'
import { makeError, makeOk } from './Tool'
import type { SkillRegistry } from './SkillRegistry'
// After:
import type { ToolDefinition } from '../core/types'
import { makeError, makeOk } from '../core/Tool'
import type { SkillRegistry } from './SkillRegistry'
```

`packages/agent-kernel/src/skills/readSkillFileTool.ts`: same pattern.

`packages/agent-kernel/src/skills/Skill.ts`: no internal imports (purely standalone). No edits.

- [ ] **Step 3: Update test imports**

Test files imported via `'@core'` (now `'agent-kernel'` after Task 3). Those imports already work via the kernel root — no edits needed. But verify:

```bash
cd packages/agent-kernel
grep -rn "from '\\.\\./" tests/skills/
```

Look for any relative imports — there shouldn't be any (tests should import via `'agent-kernel'`).

- [ ] **Step 4: Update `packages/agent-kernel/src/index.ts` — repoint skill imports**

Final block in index.ts (replacing the previous skill exports added in Task 3):

```ts
// === skills 协议 ===
export { parseSkillMd, type SkillDefinition, type ParsedSkillMd } from './skills/Skill'
export { SkillRegistry } from './skills/SkillRegistry'
export { createUseSkillTool } from './skills/useSkillTool'
export { createReadSkillFileTool } from './skills/readSkillFileTool'
```

- [ ] **Step 5: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck    # PASS
bun --cwd packages/mycli-web run test    # PASS — 133 tests
bun --cwd packages/mycli-web run build   # PASS
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: relocate skills/ subpackage in agent-kernel"
```

---

### Task 5: Move RPC layer (`hub`, `client`, `protocol`) + AgentClient SDK into the kernel

**Files:**
- Move: `packages/mycli-web/src/extension/rpc/` → `packages/agent-kernel/src/browser/rpc/`
- Move: `packages/mycli-web/src/extension/agent-client/` → `packages/agent-kernel/src/browser/agentClient/`
- Move: `packages/mycli-web/tests/rpc/` → `packages/agent-kernel/tests/browser/rpc/`
- Move: `packages/mycli-web/tests/agent-client/` → `packages/agent-kernel/tests/browser/agentClient/`
- Modify: `packages/agent-kernel/src/index.ts` — add RPC + agentClient exports
- Modify: every mycli-web file that imported these
- Modify: `packages/mycli-web/src/extension/tsconfig.json` — drop the rpc/agent-client refs
- Modify: `packages/mycli-web/tests/tsconfig.json` — drop the rpc/agent-client refs

- [ ] **Step 1: Move source + tests**

```bash
cd /Users/heguicai/myProject/mycli-web
mkdir -p packages/agent-kernel/src/browser
mkdir -p packages/agent-kernel/tests/browser
git mv packages/mycli-web/src/extension/rpc packages/agent-kernel/src/browser/rpc
git mv packages/mycli-web/src/extension/agent-client packages/agent-kernel/src/browser/agentClient
git mv packages/mycli-web/tests/rpc packages/agent-kernel/tests/browser/rpc
git mv packages/mycli-web/tests/agent-client packages/agent-kernel/tests/browser/agentClient
```

- [ ] **Step 2: Fix internal imports inside moved RPC files**

`packages/agent-kernel/src/browser/rpc/protocol.ts` — no internal imports outside zod, no changes.
`packages/agent-kernel/src/browser/rpc/client.ts` — no internal imports outside `./protocol`, unchanged.
`packages/agent-kernel/src/browser/rpc/hub.ts` — no internal imports outside `./protocol`, unchanged.

- [ ] **Step 3: Fix imports inside `agentClient/index.ts`**

Was:
```ts
import { RpcClient } from '../rpc/client'
import type { AgentEvent } from '../rpc/protocol'
```

After move (now at `agent-kernel/src/browser/agentClient/index.ts`):
```ts
import { RpcClient } from '../rpc/client'
import type { AgentEvent } from '../rpc/protocol'
```

Path is unchanged because rpc/ moved to the same parent. No edit needed. Verify with `grep`.

- [ ] **Step 4: Add the kernel re-exports**

Append to `packages/agent-kernel/src/index.ts`:

```ts
// === browser RPC ===
export { installHub, type HubHandle } from './browser/rpc/hub'
export { RpcClient } from './browser/rpc/client'
export {
  ClientCmd,
  AgentEvent as WireAgentEvent,
  Envelope,
} from './browser/rpc/protocol'

// === browser agent client SDK ===
export { createAgentClient } from './browser/agentClient'
export type {
  AgentClient,
  MessageOptions,
  OneShotOptions,
  OneShotResult,
  OneShotToolCall,
  CreateAgentClientOptions,
} from './browser/agentClient'
```

- [ ] **Step 5: Replace mycli-web imports of these moved modules**

```bash
cd packages/mycli-web
# Find all references to the moved paths
grep -rn "from '@ext/rpc\|from '\\.\\./rpc\|from '@ext/agent-client" src tests scripts
```

You'll find imports in:
- `src/extension/agentService.ts` — wait, this doesn't import from rpc directly. Skip.
- `src/extension/content/ChatApp.tsx` — `import { RpcClient } from '../rpc/client'` → `import { RpcClient } from 'agent-kernel'`
- `src/extension/background.ts` — `import { installHub } from './rpc/hub'` → `import { installHub } from 'agent-kernel'`
- `src/extension/offscreen.ts` — `import { ClientCmd } from './rpc/protocol'` → `import { ClientCmd } from 'agent-kernel'`
- All test files using `@ext/rpc/...` or `@ext/agent-client` → switch to `'agent-kernel'`

For test files like `tests/extension/domOp.routing.test.ts`, `tests/agent/agentService.test.ts` (uses `installHub`), `tests/integration/agent.live.test.ts`, etc. — replace.

- [ ] **Step 6: Drop the old project references in mycli-web tsconfigs**

`packages/mycli-web/src/extension/tsconfig.json`:

Was:
```json
"references": [
  { "path": "../extension-tools" },
  { "path": "../extension-skills" }
]
```

After this task: same (it didn't reference rpc/agent-client subprojects since they're folders inside `extension/`, not separate projects). No change.

`packages/mycli-web/tests/tsconfig.json`: also unchanged for the same reason.

- [ ] **Step 7: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck    # PASS
bun --cwd packages/mycli-web run test   # PASS — including the moved RPC tests, total still 133 (some now in kernel package)
bun --cwd packages/agent-kernel run test  # PASS — RPC + agentClient tests live here now
bun --cwd packages/mycli-web run build  # PASS
```

The total test count split should sum to the same: kernel ~38 tests (core: 25 + skills: 25 - already moved + rpc: 4 + agentClient: 4), mycli-web rest. Don't over-fixate on counts; just ensure both pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: extract rpc + agentClient into agent-kernel/browser"
```

---

### Task 6: Move `agentService` + `domOpClient` + `domOpRouter` + `offscreenChromePolyfill` into the kernel

**Files:**
- Move: `packages/mycli-web/src/extension/agentService.ts` → `packages/agent-kernel/src/browser/agentService.ts`
- Move: `packages/mycli-web/src/extension/domOpClient.ts` → `packages/agent-kernel/src/browser/domOpClient.ts`
- Move: `packages/mycli-web/src/extension/domOpRouter.ts` → `packages/agent-kernel/src/browser/domOpRouter.ts`
- Move: `packages/mycli-web/src/extension/offscreenChromePolyfill.ts` → `packages/agent-kernel/src/browser/offscreenChromePolyfill.ts`
- Move tests: `tests/agent/agentService.test.ts` → `packages/agent-kernel/tests/browser/agentService.test.ts`; `tests/extension/domOp.routing.test.ts` → `packages/agent-kernel/tests/browser/domOpRouting.test.ts`
- Modify: `packages/agent-kernel/src/index.ts` — add exports
- Update: imports in moved files
- Update: mycli-web call sites (`offscreen.ts`, `background.ts`)

- [ ] **Step 1: Move source + tests**

```bash
cd /Users/heguicai/myProject/mycli-web
git mv packages/mycli-web/src/extension/agentService.ts packages/agent-kernel/src/browser/agentService.ts
git mv packages/mycli-web/src/extension/domOpClient.ts packages/agent-kernel/src/browser/domOpClient.ts
git mv packages/mycli-web/src/extension/domOpRouter.ts packages/agent-kernel/src/browser/domOpRouter.ts
git mv packages/mycli-web/src/extension/offscreenChromePolyfill.ts packages/agent-kernel/src/browser/offscreenChromePolyfill.ts
git mv packages/mycli-web/tests/agent/agentService.test.ts packages/agent-kernel/tests/browser/agentService.test.ts
git mv packages/mycli-web/tests/extension/domOp.routing.test.ts packages/agent-kernel/tests/browser/domOpRouting.test.ts
# tests/agent/ now empty? check
ls packages/mycli-web/tests/agent/ && rmdir packages/mycli-web/tests/agent/ || true
ls packages/mycli-web/tests/extension/ && rmdir packages/mycli-web/tests/extension/ || true
```

- [ ] **Step 2: Fix imports in `agent-kernel/src/browser/agentService.ts`**

Was (after Task 3):
```ts
import {
  createAgent as defaultCreateAgent,
  type CreateAgentOptions,
  type AgentSession as CoreAgentSession,
  type ChatMessage,
  type AgentEvent as CoreAgentEvent,
  type ToolDefinition,
} from 'agent-kernel'                 // ← was 'agent-kernel' or '@core' previously
import { fetchGetTool } from 'agent-kernel'
import { extensionTools, type ExtensionToolCtx } from '@ext-tools'
import { useSkillTool, readSkillFileTool } from '@ext-skills'
import type { Settings } from './storage/settings'
```

This is INSIDE the kernel now. It can't import from `agent-kernel` itself (circular) and definitely can't import from `@ext-tools` or `@ext-skills` (those are mycli-web concerns).

Edit `packages/agent-kernel/src/browser/agentService.ts`:

```ts
import {
  createAgent as defaultCreateAgent,
  type CreateAgentOptions,
  type AgentSession as CoreAgentSession,
  type ChatMessage,
  type AgentEvent as CoreAgentEvent,
  type ToolDefinition,
} from '../core/index'  // direct internal import
import { fetchGetTool } from '../core/tools/fetchGet'
// REMOVE: extensionTools, useSkillTool, readSkillFileTool — those are consumer concerns
// REMOVE: Settings type from mycli-web — adapter takes care of it (Task 11 introduces SettingsAdapter)
```

For now (this task) we keep the existing behavior as a quick patch. We'll need a placeholder `Settings` type:

Add at top of file:

```ts
// Temporary local shape; replaced by SettingsAdapter interface in Phase 2.
export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  systemPromptAddendum?: string
  toolMaxIterations?: number
  // additional fields the consumer settings object may carry — passthrough
  [key: string]: unknown
}
```

Remove the import of `Settings` from `'./storage/settings'`.

The default `tools` list previously was `[fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool]`. In the kernel-only world, the kernel doesn't know about `extensionTools` or skill tools — those come from the consumer. The new default:

```ts
const allTools = deps.tools ?? [fetchGetTool]
```

(Just fetchGetTool, since it's the only tool kernel ships. Consumer is expected to pass their own list including useSkill/readSkillFile if they want skills.)

This is a behavior change for mycli-web — handled by Step 4 below.

- [ ] **Step 3: Fix imports in `agent-kernel/src/browser/domOpClient.ts`, `domOpRouter.ts`, `offscreenChromePolyfill.ts`**

`domOpClient.ts` — no kernel imports needed; uses chrome.* globals only. No changes.

`domOpRouter.ts` — same, only chrome.* usage. No changes.

`offscreenChromePolyfill.ts`:
```ts
// Was:
import { callChromeApi } from './domOpClient'
// After move (same dir):
import { callChromeApi } from './domOpClient'
```

No change needed (same relative path).

- [ ] **Step 4: Update mycli-web call sites**

`packages/mycli-web/src/extension/offscreen.ts`:

Old imports:
```ts
import { sendDomOp, callChromeApi } from './domOpClient'
import { createAgentService } from './agentService'
import { polyfillChromeApiInOffscreen } from './offscreenChromePolyfill'
```

Replace with:
```ts
import { sendDomOp, callChromeApi } from 'agent-kernel'
import { createAgentService } from 'agent-kernel'
import { polyfillChromeApiInOffscreen } from 'agent-kernel'
```

But — these need to be exported by kernel index.ts (next step).

Also fix the `tools` parameter passed to `createAgentService`. Currently mycli-web's offscreen relies on the default tool list including `useSkillTool` and `readSkillFileTool`. Since the kernel default now is just `[fetchGetTool]`, mycli-web has to pass them explicitly:

In `packages/mycli-web/src/extension/offscreen.ts`, find the `createAgentService({...})` call and add explicit `tools`:

```ts
import { extensionTools } from '@ext-tools'
import { useSkillTool, readSkillFileTool } from '@ext-skills'
import { fetchGetTool } from 'agent-kernel'
// ...
const agentService = createAgentService({
  loadSettings,
  emit,
  appendMessage,
  listMessagesByConversation,
  updateMessage,
  activeConversationId,
  buildToolContext,
  tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool], // explicit now
})
```

`packages/mycli-web/src/extension/background.ts`:

Old imports:
```ts
import { installDomOpRouter } from './domOpRouter'
```

New:
```ts
import { installDomOpRouter } from 'agent-kernel'
```

- [ ] **Step 5: Update kernel `index.ts` exports**

Append to `packages/agent-kernel/src/index.ts`:

```ts
// === browser agent service ===
export { createAgentService, type AgentService, type AgentServiceDeps, type RunTurnInput } from './browser/agentService'

// === browser RPC helpers / chrome.* polyfill ===
export { sendDomOp, callChromeApi } from './browser/domOpClient'
export { installDomOpRouter } from './browser/domOpRouter'
export { polyfillChromeApiInOffscreen } from './browser/offscreenChromePolyfill'
```

- [ ] **Step 6: Update test imports for moved tests**

`packages/agent-kernel/tests/browser/agentService.test.ts` — change `from '@ext/agentService'` → `from 'agent-kernel'`.
`packages/agent-kernel/tests/browser/domOpRouting.test.ts` — change `from '@ext/domOpClient'`, `from '@ext/domOpRouter'` → `from 'agent-kernel'`.

The chrome multi-context bus mock in `tests/mocks/chromeMultiContext.ts` is still in mycli-web. Tests in agent-kernel that need it must import via the workspace dep — but that mock file isn't part of the public API. Decision: copy `tests/mocks/chromeMultiContext.ts` into `packages/agent-kernel/tests/mocks/chromeMultiContext.ts` (it's a test helper, not production code). Both copies can drift independently if needed; for now they stay in sync.

```bash
cp packages/mycli-web/tests/mocks/chromeMultiContext.ts packages/agent-kernel/tests/mocks/chromeMultiContext.ts
```

Update `tests/browser/domOpRouting.test.ts` to import the local copy:

```ts
import { installMultiContextChrome, type MultiContextBus } from '../mocks/chromeMultiContext'
```

- [ ] **Step 7: Set up vitest config in agent-kernel**

Create `packages/agent-kernel/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      'agent-kernel': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    include: ['tests/**/*.test.ts'],
  },
})
```

(Aliasing `agent-kernel` to its own `src/index.ts` lets the kernel's tests use the same import style as consumers.)

- [ ] **Step 8: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck                                 # PASS
bun --cwd packages/agent-kernel run test          # PASS — kernel-side tests
bun --cwd packages/mycli-web run test             # PASS — consumer-side tests
bun --cwd packages/mycli-web run build            # PASS
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract agentService + dom op helpers into agent-kernel"
```

---

### Task 7: Move storage primitives (db, conversations, messages, auditLog) into the kernel with namespace

**Files:**
- Move: `packages/mycli-web/src/extension/storage/db.ts` → `packages/agent-kernel/src/browser/storage/db.ts`
- Move: `packages/mycli-web/src/extension/storage/conversations.ts` → `packages/agent-kernel/src/browser/storage/conversations.ts`
- Move: `packages/mycli-web/src/extension/storage/messages.ts` → `packages/agent-kernel/src/browser/storage/messages.ts`
- Move: `packages/mycli-web/src/extension/storage/auditLog.ts` → `packages/agent-kernel/src/browser/storage/auditLog.ts`
- Move corresponding test files
- Modify: `packages/agent-kernel/src/browser/storage/db.ts` — change DB name from `mycli-web` to `agent-kernel`
- Modify: `packages/agent-kernel/src/index.ts` — add storage exports
- Update: imports in mycli-web's offscreen.ts (which uses these stores)
- Keep in mycli-web: `storage/settings.ts`, `storage/transient.ts`, `storage/rules.ts`, `storage/skillData.ts`, `storage/skills.ts` (these are mycli-web's own concerns)

- [ ] **Step 1: Move files**

```bash
cd /Users/heguicai/myProject/mycli-web
mkdir -p packages/agent-kernel/src/browser/storage
mkdir -p packages/agent-kernel/tests/browser/storage
git mv packages/mycli-web/src/extension/storage/db.ts packages/agent-kernel/src/browser/storage/db.ts
git mv packages/mycli-web/src/extension/storage/conversations.ts packages/agent-kernel/src/browser/storage/conversations.ts
git mv packages/mycli-web/src/extension/storage/messages.ts packages/agent-kernel/src/browser/storage/messages.ts
git mv packages/mycli-web/src/extension/storage/auditLog.ts packages/agent-kernel/src/browser/storage/auditLog.ts
git mv packages/mycli-web/tests/storage/db.test.ts packages/agent-kernel/tests/browser/storage/db.test.ts
git mv packages/mycli-web/tests/storage/conversations.test.ts packages/agent-kernel/tests/browser/storage/conversations.test.ts
git mv packages/mycli-web/tests/storage/messages.test.ts packages/agent-kernel/tests/browser/storage/messages.test.ts
git mv packages/mycli-web/tests/storage/auditLog.test.ts packages/agent-kernel/tests/browser/storage/auditLog.test.ts
```

- [ ] **Step 2: Change DB name to `agent-kernel`**

Edit `packages/agent-kernel/src/browser/storage/db.ts`. Find the `openDb` function (or wherever the DB name string `'mycli-web'` appears) and change it to `'agent-kernel'`.

```bash
grep -n "'mycli-web'" packages/agent-kernel/src/browser/storage/db.ts
```

Replace `'mycli-web'` with `'agent-kernel'` in the DB constant.

- [ ] **Step 3: Fix internal imports in moved storage files**

`conversations.ts`, `messages.ts`, `auditLog.ts` import `from './db'` — same dir after move, no edit needed.

- [ ] **Step 4: Add kernel exports**

Append to `packages/agent-kernel/src/index.ts`:

```ts
// === browser storage (default IDB-backed conversation/message/audit stores) ===
export {
  openDb,
  type SkillRow,
  type ConversationRow,
  type MessageRow,
  type AuditLogRow,
} from './browser/storage/db'
export {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
} from './browser/storage/conversations'
export {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
} from './browser/storage/messages'
export { appendAuditEntry, listAuditEntries } from './browser/storage/auditLog'
```

(Adjust the actual export list to match what the source files actually export — check with `grep "^export" packages/agent-kernel/src/browser/storage/*.ts`.)

- [ ] **Step 5: Update mycli-web call sites**

`packages/mycli-web/src/extension/offscreen.ts` imports:

```ts
// Was:
import {
  createConversation,
  getConversation,
  listConversations,
} from './storage/conversations'
import {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
} from './storage/messages'
```

Now:
```ts
import {
  createConversation,
  getConversation,
  listConversations,
  appendMessage,
  listMessagesByConversation,
  updateMessage,
} from 'agent-kernel'
```

Same for any other file (settings.ts in mycli-web still imports `db.ts` for SkillRow / SettingsRow — wait, settings.ts does NOT touch db. skillData.ts and skills.ts use db. Those stay in mycli-web for now, so they need to import the kernel's db.

Edit `packages/mycli-web/src/extension/storage/skills.ts`:
```ts
// Was:
import { openDb, type SkillRow } from './db'
// Now:
import { openDb, type SkillRow } from 'agent-kernel'
```

Same for `skillData.ts`.

But — there's a problem. `skills.ts` and `skillData.ts` use `db.ts`'s `openDb()` which now opens `'agent-kernel'` DB. If mycli-web wants its skill rows in its OWN DB (not the kernel's), this won't work.

Decision (per spec §命名空间隔离): kernel DB holds conversations/messages/auditLog. Skills metadata (which skills the user installed; skill-private storage) is consumer concern. mycli-web should keep its own `db.ts` for skill rows.

Adjust strategy: copy `db.ts`'s schema patterns but make mycli-web have a separate `db.ts` for its OWN stores (skills, skillData). The kernel's db.ts owns conversations/messages/auditLog only.

Actually, mycli-web today has skills/skillData stores even though skills are bundled (no installation). Those tables aren't actively used. For this task: **delete the unused skills/skillData stores** rather than dragging them through the migration.

Run:
```bash
ls packages/mycli-web/src/extension/storage/
# Likely: settings.ts skills.ts skillData.ts transient.ts rules.ts
```

If `skills.ts` and `skillData.ts` are imported anywhere in mycli-web that's used:
```bash
grep -rn "from '\\.\\./storage/skills\\|from '\\.\\./storage/skillData" packages/mycli-web/src
```

Likely no production import (they were scaffolded for the bigger user-installable-skills feature that never landed). If grep returns empty, delete:

```bash
git rm packages/mycli-web/src/extension/storage/skills.ts
git rm packages/mycli-web/src/extension/storage/skillData.ts
git rm packages/mycli-web/tests/storage/skills.test.ts
git rm packages/mycli-web/tests/storage/skillData.test.ts
```

(If there ARE production imports, escalate — the task changes scope.)

- [ ] **Step 6: Update mycli-web's tsconfig** if any references reference the storage subpath (they don't typically — storage is just files inside extension/).

- [ ] **Step 7: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck                          # PASS
bun --cwd packages/agent-kernel run test   # PASS — moved storage tests
bun --cwd packages/mycli-web run test       # PASS — remaining tests (will be fewer if you deleted skills/skillData tests)
bun --cwd packages/mycli-web run build      # PASS
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: move conversations/messages/auditLog stores into agent-kernel/browser/storage (DB renamed to 'agent-kernel'); drop unused skills/skillData scaffolds"
```

---

### Task 8: Move `tools/fetchGet` test to kernel + sync test mocks

**Files:**
- Move: `packages/mycli-web/tests/tools/fetchGet.test.ts` → `packages/agent-kernel/tests/core/tools/fetchGet.test.ts`
- Move: `packages/mycli-web/tests/tools/registry.test.ts` → `packages/agent-kernel/tests/core/registry.test.ts`
- Move: `packages/mycli-web/tests/agent/tokenBudget.test.ts` → `packages/agent-kernel/tests/core/tokenBudget.test.ts`
- Move: `packages/mycli-web/tests/agent-core/createAgent.test.ts` (if not already moved — verify) → `packages/agent-kernel/tests/core/createAgent.test.ts`
- Move: `packages/mycli-web/tests/protocol.test.ts` → `packages/agent-kernel/tests/core/protocol.test.ts`
- Move: `packages/mycli-web/tests/extension-skills/{loader,bundled}.test.ts` — `loader` is a kernel concern (tests pure helper), so → kernel; `bundled` is mycli-web concern (tests bundled summarizePage skill exists), so it stays
- Update: imports in moved tests
- Sync test setup files: kernel needs its own `tests/setup.ts` if any tests use IDB

- [ ] **Step 1: Inventory remaining `packages/mycli-web/tests/` to decide what's kernel vs consumer**

```bash
cd packages/mycli-web
ls -R tests/
```

What stays in mycli-web (tests for mycli-web-specific concerns):
- `tests/storage/settings.test.ts`, `transient.test.ts`
- `tests/extension-skills/bundled.test.ts` (bundled summarizePage skill round-trip)
- `tests/tools/readPage.test.ts` (readPage is a mycli-web tool)
- `tests/integration/agent.live.test.ts` (uses live LLM; could go either way — keep in mycli-web for now since it imports from `'agent-kernel'` directly)

What moves to kernel:
- `tests/agent-core/createAgent.test.ts` (if not already moved in Task 3)
- `tests/agent/tokenBudget.test.ts`
- `tests/tools/fetchGet.test.ts`
- `tests/tools/registry.test.ts`
- `tests/protocol.test.ts`
- `tests/extension-skills/loader.test.ts` (the pure `buildRegistryFromModules` helper test — but loader.ts itself stays in mycli-web extension-skills/ for now; the helper signature is what kernel will provide eventually. Actually loader.ts currently only exists in mycli-web, NOT moved to kernel. Decision: this test stays in mycli-web until Task 16 introduces kernel viteGlobLoader)

So move only: createAgent.test.ts (if not already), tokenBudget.test.ts, fetchGet.test.ts, registry.test.ts, protocol.test.ts.

- [ ] **Step 2: Move them**

```bash
cd /Users/heguicai/myProject/mycli-web
mkdir -p packages/agent-kernel/tests/core/tools
# (verify each file exists at the source first; some may already have moved)
git mv packages/mycli-web/tests/agent-core/createAgent.test.ts packages/agent-kernel/tests/core/createAgent.test.ts 2>/dev/null || true
git mv packages/mycli-web/tests/agent/tokenBudget.test.ts packages/agent-kernel/tests/core/tokenBudget.test.ts
git mv packages/mycli-web/tests/tools/fetchGet.test.ts packages/agent-kernel/tests/core/tools/fetchGet.test.ts
git mv packages/mycli-web/tests/tools/registry.test.ts packages/agent-kernel/tests/core/registry.test.ts
git mv packages/mycli-web/tests/protocol.test.ts packages/agent-kernel/tests/core/protocol.test.ts
# Clean up empty dirs
rmdir packages/mycli-web/tests/agent-core 2>/dev/null || true
rmdir packages/mycli-web/tests/agent 2>/dev/null || true
```

- [ ] **Step 3: Update imports in moved tests**

Most of these imported from `'@core'` originally — and were already converted to `'agent-kernel'` in Task 3. Re-verify:

```bash
grep -rn "@core\|@ext\b" packages/agent-kernel/tests/
```

Should return empty. If not, replace with `'agent-kernel'`.

- [ ] **Step 4: Set up the kernel's `tests/setup.ts`** for tests that use IDB

```bash
cat > packages/agent-kernel/tests/setup.ts <<'EOF'
import 'fake-indexeddb/auto'
EOF
```

Update `packages/agent-kernel/vitest.config.ts`:

```ts
test: {
  environment: 'jsdom',
  globals: true,
  setupFiles: ['./tests/setup.ts'],
  include: ['tests/**/*.test.ts'],
},
```

Also need fake-indexeddb in kernel's deps:

Edit `packages/agent-kernel/package.json` — add to `devDependencies`:

```json
"fake-indexeddb": "^6.0.0",
"jsdom": "^24.1.0",
"idb": "^8.0.0"
```

(`idb` is what `db.ts` imports — needs to be available to the kernel package directly.)

Run `bun install` from root.

- [ ] **Step 5: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck                          # PASS
bun --cwd packages/agent-kernel run test   # PASS — many more tests now
bun --cwd packages/mycli-web run test       # PASS — fewer tests (the ones not moved)
bun --cwd packages/mycli-web run build      # PASS
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move agent-core tests into agent-kernel/tests/core"
```

---

## Phase 2 — Adapter interfaces + assembly helpers (7 tasks)

### Task 9: Define `SettingsAdapter` interface and refactor `agentService` to use it

**Files:**
- Create: `packages/agent-kernel/src/adapters/SettingsAdapter.ts`
- Create: `packages/agent-kernel/src/adapters/index.ts`
- Modify: `packages/agent-kernel/src/browser/agentService.ts` — accept `SettingsAdapter` instead of `loadSettings: () => Promise<Settings>`
- Modify: `packages/agent-kernel/src/index.ts` — re-export
- Modify: `packages/mycli-web/src/extension/offscreen.ts` — pass an adapter
- Create: `packages/mycli-web/src/extension/settingsAdapter.ts`
- Update: tests that pass `loadSettings`

- [ ] **Step 1: Create the adapter interface**

```bash
mkdir -p packages/agent-kernel/src/adapters
```

`packages/agent-kernel/src/adapters/SettingsAdapter.ts`:

```ts
/**
 * Minimum settings the kernel needs to drive the agent loop. Consumers may
 * carry additional fields in their own settings objects; the adapter is
 * responsible for narrowing to this shape on load.
 */
export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  systemPromptAddendum?: string
  toolMaxIterations?: number
}

export interface SettingsAdapter {
  /** Called once per turn to fetch current settings. */
  load(): Promise<Settings>
}
```

`packages/agent-kernel/src/adapters/index.ts`:

```ts
export type { Settings, SettingsAdapter } from './SettingsAdapter'
```

- [ ] **Step 2: Refactor `agentService.ts` to take a `SettingsAdapter`**

Edit `packages/agent-kernel/src/browser/agentService.ts`:

Replace the in-file `Settings` placeholder type with the import from adapters:

```ts
import type { Settings, SettingsAdapter } from '../adapters/SettingsAdapter'
```

Change the deps:

```ts
export interface AgentServiceDeps {
  // Was: loadSettings: () => Promise<Settings>
  settings: SettingsAdapter
  emit: (ev: any) => void
  // ...rest unchanged
}
```

Inside `runTurn`:

```ts
// Was: const settings = await deps.loadSettings()
const settings = await deps.settings.load()
```

- [ ] **Step 3: Re-export from kernel index**

Append to `packages/agent-kernel/src/index.ts`:

```ts
// === adapters ===
export type { Settings, SettingsAdapter } from './adapters'
```

- [ ] **Step 4: Create mycli-web's adapter**

`packages/mycli-web/src/extension/settingsAdapter.ts`:

```ts
import type { SettingsAdapter, Settings } from 'agent-kernel'
import { loadSettings } from './storage/settings'

export const mycliSettingsAdapter: SettingsAdapter = {
  async load(): Promise<Settings> {
    const s = await loadSettings()
    return {
      apiKey: s.apiKey,
      baseUrl: s.baseUrl,
      model: s.model,
      systemPromptAddendum: s.systemPromptAddendum || undefined,
      toolMaxIterations: s.toolMaxIterations,
    }
  },
}
```

- [ ] **Step 5: Update `packages/mycli-web/src/extension/offscreen.ts`**

Replace the `loadSettings` field in the `createAgentService(...)` call with:

```ts
import { mycliSettingsAdapter } from './settingsAdapter'

const agentService = createAgentService({
  settings: mycliSettingsAdapter,    // <-- was loadSettings
  emit,
  appendMessage,
  listMessagesByConversation,
  updateMessage,
  activeConversationId,
  buildToolContext,
  tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool],
})
```

Remove the unused `import { loadSettings } from './storage/settings'` if no longer referenced.

- [ ] **Step 6: Update `packages/agent-kernel/tests/browser/agentService.test.ts`**

Tests passed `loadSettings` — change to `settings`:

```ts
// Was:
loadSettings: async () => opts.settings ?? defaultSettings(),
// Now:
settings: { load: async () => opts.settings ?? defaultSettings() },
```

Search-and-replace all 9 test cases in this file.

- [ ] **Step 7: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck                          # PASS
bun --cwd packages/agent-kernel run test   # PASS
bun --cwd packages/mycli-web run test       # PASS
bun --cwd packages/mycli-web run build      # PASS
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): SettingsAdapter interface; agentService takes adapter"
```

---

### Task 10: Define `MessageStoreAdapter` + provide default IDB implementation

**Files:**
- Create: `packages/agent-kernel/src/adapters/MessageStoreAdapter.ts`
- Create: `packages/agent-kernel/src/browser/storage/createIdbMessageStore.ts`
- Modify: `packages/agent-kernel/src/browser/agentService.ts` — accept `messageStore` instead of individual functions
- Modify: `packages/agent-kernel/src/adapters/index.ts`
- Modify: `packages/agent-kernel/src/index.ts`
- Modify: `packages/mycli-web/src/extension/offscreen.ts`
- Update: `agentService.test.ts`

- [ ] **Step 1: Create the adapter interface**

`packages/agent-kernel/src/adapters/MessageStoreAdapter.ts`:

```ts
export interface MessageRecord {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system-synth'
  content: unknown
  createdAt: number
  pending?: boolean
  compacted?: boolean
}

export interface AppendMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

export interface AppendedMessage {
  id: string
  createdAt: number
}

export interface MessageStoreAdapter {
  activeConversationId(): Promise<string>
  append(msg: AppendMessageInput): Promise<AppendedMessage>
  list(conversationId: string): Promise<MessageRecord[]>
  update(id: string, patch: { content?: string; pending?: boolean }): Promise<void>
}
```

Update `packages/agent-kernel/src/adapters/index.ts`:

```ts
export type { Settings, SettingsAdapter } from './SettingsAdapter'
export type {
  MessageStoreAdapter,
  MessageRecord,
  AppendMessageInput,
  AppendedMessage,
} from './MessageStoreAdapter'
```

- [ ] **Step 2: Create the default IDB-backed implementation**

`packages/agent-kernel/src/browser/storage/createIdbMessageStore.ts`:

```ts
import {
  appendMessage,
  listMessagesByConversation,
  updateMessage,
} from './messages'
import {
  createConversation,
  listConversations,
} from './conversations'
import type { MessageStoreAdapter } from '../../adapters/MessageStoreAdapter'

export interface CreateIdbMessageStoreOptions {
  /** The default conversation title used when a new conversation is created. */
  defaultConversationTitle?: string
}

export function createIdbMessageStore(
  opts: CreateIdbMessageStoreOptions = {},
): MessageStoreAdapter {
  const title = opts.defaultConversationTitle ?? 'New chat'
  return {
    async activeConversationId() {
      const all = await listConversations()
      if (all.length > 0) return all[0].id
      const conv = await createConversation({ title })
      return conv.id
    },
    async append(msg) {
      return appendMessage(msg)
    },
    async list(conversationId) {
      return listMessagesByConversation(conversationId)
    },
    async update(id, patch) {
      return updateMessage(id, patch)
    },
  }
}
```

- [ ] **Step 3: Refactor agentService**

In `packages/agent-kernel/src/browser/agentService.ts`:

```ts
import type { MessageStoreAdapter } from '../adapters/MessageStoreAdapter'

export interface AgentServiceDeps {
  settings: SettingsAdapter
  emit: (ev: any) => void
  // Was: appendMessage, listMessagesByConversation, updateMessage, activeConversationId
  messageStore: MessageStoreAdapter
  buildToolContext: (cid: string | undefined) => Promise<Record<string, unknown>>
  tools?: ToolDefinition<any, any, any>[]
  createAgent?: typeof defaultCreateAgent
}
```

Replace the 4 individual calls inside `runTurn`:

```ts
// Was: const cid = ephemeral ? null : await deps.activeConversationId()
const cid = ephemeral ? null : await deps.messageStore.activeConversationId()

// Was: await deps.appendMessage({...})
await deps.messageStore.append({...})

// Was: await deps.listMessagesByConversation(cid!)
await deps.messageStore.list(cid!)

// Was: await deps.updateMessage(id, patch)
await deps.messageStore.update(id, patch)
```

- [ ] **Step 4: Re-export**

Append to `packages/agent-kernel/src/index.ts`:

```ts
export type {
  MessageStoreAdapter,
  MessageRecord,
  AppendMessageInput,
  AppendedMessage,
} from './adapters'
export { createIdbMessageStore } from './browser/storage/createIdbMessageStore'
```

- [ ] **Step 5: Update mycli-web's offscreen.ts**

```ts
import {
  createAgentService,
  createIdbMessageStore,
  fetchGetTool,
  // ...
} from 'agent-kernel'

const agentService = createAgentService({
  settings: mycliSettingsAdapter,
  emit,
  messageStore: createIdbMessageStore({ defaultConversationTitle: 'mycli chat' }),
  buildToolContext,
  tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool],
})
```

Remove now-unused imports (`appendMessage`, `listMessagesByConversation`, `updateMessage`, `activeConversationId` if they're no longer used elsewhere in offscreen.ts — verify via grep).

- [ ] **Step 6: Update tests**

`packages/agent-kernel/tests/browser/agentService.test.ts`: replace deps shape:

```ts
// Was:
appendMessage: vi.fn(...),
listMessagesByConversation: vi.fn(...),
updateMessage: vi.fn(...),
activeConversationId: vi.fn(...),

// Now:
messageStore: {
  append: vi.fn(...),
  list: vi.fn(...),
  update: vi.fn(...),
  activeConversationId: vi.fn(...),
},
```

Update each of the 9 test cases.

- [ ] **Step 7: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
```

All four PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): MessageStoreAdapter + default createIdbMessageStore"
```

---

### Task 11: Define `ToolContextBuilder` + finalize `agentService` deps

**Files:**
- Create: `packages/agent-kernel/src/adapters/ToolContextBuilder.ts`
- Modify: `packages/agent-kernel/src/browser/agentService.ts`
- Modify: kernel adapters/index.ts + main index.ts
- Modify: mycli-web offscreen.ts
- Update: agentService.test.ts

- [ ] **Step 1: Create the interface**

`packages/agent-kernel/src/adapters/ToolContextBuilder.ts`:

```ts
/**
 * Builds the per-turn ToolExecContext extension that gets merged into
 * each tool's `ctx` parameter. Consumers know what fields their tools
 * need (e.g. tabId, rpc); the kernel stays agnostic.
 *
 * `cid` is the active conversation id, or undefined for ephemeral turns.
 */
export interface ToolContextBuilder<Ctx extends Record<string, unknown> = Record<string, unknown>> {
  build(cid: string | undefined): Promise<Ctx>
}
```

Update `packages/agent-kernel/src/adapters/index.ts`:

```ts
export type { Settings, SettingsAdapter } from './SettingsAdapter'
export type {
  MessageStoreAdapter,
  MessageRecord,
  AppendMessageInput,
  AppendedMessage,
} from './MessageStoreAdapter'
export type { ToolContextBuilder } from './ToolContextBuilder'
```

- [ ] **Step 2: Refactor agentService**

In `packages/agent-kernel/src/browser/agentService.ts`:

```ts
import type { ToolContextBuilder } from '../adapters/ToolContextBuilder'

export interface AgentServiceDeps {
  settings: SettingsAdapter
  emit: (ev: any) => void
  messageStore: MessageStoreAdapter
  // Was: buildToolContext: (cid: string | undefined) => Promise<Record<string, unknown>>
  toolContext: ToolContextBuilder
  tools?: ToolDefinition<any, any, any>[]
  createAgent?: typeof defaultCreateAgent
}
```

Inside `runTurn`:

```ts
// Was: const toolContext = await deps.buildToolContext(cid ?? undefined)
const toolContext = await deps.toolContext.build(cid ?? undefined)
```

- [ ] **Step 3: Re-export**

Append to `packages/agent-kernel/src/index.ts`:

```ts
export type { ToolContextBuilder } from './adapters'
```

- [ ] **Step 4: Update mycli-web's offscreen.ts**

```ts
const mycliToolContext: ToolContextBuilder = {
  async build(cid) {
    const tabId = (await guessActiveTab())?.id
    return {
      rpc: { domOp: sendDomOp, chromeApi: callChromeApi },
      tabId,
      conversationId: cid,
    }
  },
}

const agentService = createAgentService({
  settings: mycliSettingsAdapter,
  emit,
  messageStore: createIdbMessageStore({ defaultConversationTitle: 'mycli chat' }),
  toolContext: mycliToolContext,
  tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool],
})
```

Remove the previous `buildToolContext` standalone helper if no longer used.

- [ ] **Step 5: Update tests**

`packages/agent-kernel/tests/browser/agentService.test.ts`:

```ts
// Was: buildToolContext: vi.fn(async () => ({...}))
// Now: toolContext: { build: vi.fn(async () => ({...})) }
```

Update all 9 test cases.

- [ ] **Step 6: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): ToolContextBuilder adapter; agentService deps stabilized"
```

---

### Task 12: Implement `installKernelBackground` helper + collapse mycli-web background.ts

**Files:**
- Create: `packages/agent-kernel/src/browser/installKernelBackground.ts`
- Create: `packages/agent-kernel/tests/browser/installKernelBackground.test.ts`
- Modify: `packages/agent-kernel/src/index.ts`
- Modify: `packages/mycli-web/src/extension/background.ts` — collapse to ~15 lines

- [ ] **Step 1: Write the failing test**

`packages/agent-kernel/tests/browser/installKernelBackground.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installKernelBackground } from 'agent-kernel'

beforeEach(() => {
  // Reset chrome mock per test
  ;(globalThis as any).chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getContexts: vi.fn(async () => []),
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      lastError: undefined,
    },
    action: { onClicked: { addListener: vi.fn() } },
    commands: { onCommand: { addListener: vi.fn() } },
    storage: {
      session: { setAccessLevel: vi.fn(async () => {}) },
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
      Reason: { IFRAME_SCRIPTING: 'IFRAME_SCRIPTING' },
    },
    tabs: { sendMessage: vi.fn() },
  }
})

describe('installKernelBackground', () => {
  it('registers the hub onConnect listener', () => {
    installKernelBackground({
      offscreenUrl: 'chrome-extension://abc/html/offscreen.html',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect(chrome.runtime.onConnect.addListener).toHaveBeenCalled()
  })

  it('registers the dom op router on chrome.runtime.onMessage', () => {
    installKernelBackground({
      offscreenUrl: 'chrome-extension://abc/html/offscreen.html',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled()
  })

  it('registers action onClicked when no custom onActivate is given', () => {
    installKernelBackground({
      offscreenUrl: 'x',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect((chrome.action!.onClicked.addListener as any)).toHaveBeenCalled()
  })

  it('registers commands.onCommand when toggleCommand is provided', () => {
    installKernelBackground({
      offscreenUrl: 'x',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
      toggleCommand: 'toggle-chat',
    })
    expect((chrome.commands!.onCommand.addListener as any)).toHaveBeenCalled()
  })

  it('does not register commands.onCommand when toggleCommand is undefined', () => {
    installKernelBackground({
      offscreenUrl: 'x',
      offscreenReason: 'IFRAME_SCRIPTING' as any,
    })
    expect((chrome.commands!.onCommand.addListener as any)).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun --cwd packages/agent-kernel run test installKernelBackground
```

Expected: FAIL — `installKernelBackground` not exported.

- [ ] **Step 3: Implement `installKernelBackground`**

`packages/agent-kernel/src/browser/installKernelBackground.ts`:

```ts
import { installHub } from './rpc/hub'
import { installDomOpRouter } from './domOpRouter'

export interface InstallKernelBackgroundOptions {
  /** chrome.runtime.getURL('html/offscreen.html') — provided by the consumer */
  offscreenUrl: string
  /** Justification reason for chrome.offscreen.createDocument */
  offscreenReason: chrome.offscreen.Reason
  /** Hub mode; default 'offscreen-forward' */
  hubMode?: 'echo' | 'offscreen-forward'
  /** Keyboard command name to bind to "activate on tab"; undefined = don't bind */
  toggleCommand?: string
  /** Override the default activate-on-tab logic */
  onActivate?: (tabId: number) => Promise<void>
}

const DEFAULT_OFFSCREEN_JUSTIFICATION =
  'Host agent runtime and sandbox iframes for code-capable skills.'

export function installKernelBackground(opts: InstallKernelBackgroundOptions): void {
  const ensureOffscreen = async (): Promise<void> => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      documentUrls: [opts.offscreenUrl],
    })
    if (contexts.length > 0) return
    await chrome.offscreen.createDocument({
      url: opts.offscreenUrl,
      reasons: [opts.offscreenReason],
      justification: DEFAULT_OFFSCREEN_JUSTIFICATION,
    })
  }

  const defaultActivate = async (tabId: number): Promise<void> => {
    await ensureOffscreen()
    try {
      await chrome.tabs.sendMessage(tabId, { kind: 'content/activate' })
    } catch {
      // content script may not be loaded (chrome:// pages); silent ignore
    }
  }
  const activate = opts.onActivate ?? defaultActivate

  // Lifecycle hooks.
  chrome.runtime.onInstalled.addListener(async () => {
    await ensureOffscreen()
  })
  chrome.runtime.onStartup.addListener(async () => {
    await ensureOffscreen()
  })

  // Action click → activate.
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id) await activate(tab.id)
  })

  // Optional keyboard command.
  if (opts.toggleCommand) {
    const cmdName = opts.toggleCommand
    chrome.commands.onCommand.addListener(async (command, tab) => {
      if (command !== cmdName) return
      if (tab?.id) await activate(tab.id)
    })
  }

  // Widen chrome.storage.session so content scripts can read transient UI state.
  chrome.storage.session
    .setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' as chrome.storage.AccessLevel,
    })
    .catch((e) => console.warn('[agent-kernel] widen session storage failed:', e))

  // Install hub + dom op router.
  const hub = installHub({ mode: opts.hubMode ?? 'offscreen-forward' })
  installDomOpRouter()

  // Forward SW-side runtime errors to all session ports for F12 visibility.
  ;(self as any).addEventListener?.('error', (e: any) => {
    hub.broadcastRuntimeError(e?.message ?? 'uncaught error', e?.error?.stack)
  })
  ;(self as any).addEventListener?.('unhandledrejection', (e: any) => {
    const reason = e?.reason
    const message =
      typeof reason === 'string' ? reason : reason?.message ?? 'unhandled rejection'
    hub.broadcastRuntimeError(message, reason?.stack)
  })

  console.log('[agent-kernel] background SW booted')
}
```

- [ ] **Step 4: Re-export**

Append to `packages/agent-kernel/src/index.ts`:

```ts
export {
  installKernelBackground,
  type InstallKernelBackgroundOptions,
} from './browser/installKernelBackground'
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun --cwd packages/agent-kernel run test installKernelBackground
```

Expected: PASS — 5/5 green.

- [ ] **Step 6: Collapse mycli-web's `background.ts`**

Replace the entire content of `packages/mycli-web/src/extension/background.ts` with:

```ts
import { installKernelBackground } from 'agent-kernel'

installKernelBackground({
  offscreenUrl: chrome.runtime.getURL('html/offscreen.html'),
  offscreenReason: 'IFRAME_SCRIPTING' as chrome.offscreen.Reason,
  hubMode: 'offscreen-forward',
  toggleCommand: 'toggle-chat',
})
```

That's the entire file. ~10 lines.

If mycli-web previously did anything custom in `activateOnTab` (like setting `chrome.storage.session` `panelOpen`), keep that custom behavior:

```ts
import { installKernelBackground } from 'agent-kernel'
import { setTransientUi, getTransientUi } from './storage/transient'

installKernelBackground({
  offscreenUrl: chrome.runtime.getURL('html/offscreen.html'),
  offscreenReason: 'IFRAME_SCRIPTING' as chrome.offscreen.Reason,
  hubMode: 'offscreen-forward',
  toggleCommand: 'toggle-chat',
  onActivate: async (tabId) => {
    const ui = await getTransientUi()
    await setTransientUi({
      activatedTabs: { ...ui.activatedTabs, [String(tabId)]: true },
      panelOpen: true,
    })
    try {
      await chrome.tabs.sendMessage(tabId, { kind: 'content/activate' })
    } catch {
      // ignore
    }
  },
})
```

- [ ] **Step 7: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): installKernelBackground helper; mycli-web background.ts collapses to ~15 lines"
```

---

### Task 13: Implement `bootKernelOffscreen` helper + collapse mycli-web offscreen.ts

**Files:**
- Create: `packages/agent-kernel/src/browser/bootKernelOffscreen.ts`
- Create: `packages/agent-kernel/tests/browser/bootKernelOffscreen.test.ts`
- Modify: `packages/agent-kernel/src/index.ts`
- Modify: `packages/mycli-web/src/extension/offscreen.ts` — collapse to ~25 lines

- [ ] **Step 1: Write the failing test**

`packages/agent-kernel/tests/browser/bootKernelOffscreen.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { bootKernelOffscreen } from 'agent-kernel'

describe('bootKernelOffscreen', () => {
  it('registers chrome.runtime.onConnect for "sw-to-offscreen" and accepts a port', () => {
    const onConnectListeners: Array<(port: any) => void> = []
    ;(globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: (cb: any) => onConnectListeners.push(cb) },
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        sendMessage: vi.fn(),
      },
    }

    bootKernelOffscreen({
      settings: { load: async () => ({ apiKey: 'k', baseUrl: 'b', model: 'm' }) },
      messageStore: {
        activeConversationId: async () => 'c',
        append: async () => ({ id: 'i', createdAt: 0 }),
        list: async () => [],
        update: async () => {},
      },
      toolContext: { build: async () => ({}) },
      tools: [],
    })

    // The port handler should be registered.
    expect(onConnectListeners.length).toBeGreaterThanOrEqual(1)

    // Simulate SW connecting via the expected port name.
    const port = {
      name: 'sw-to-offscreen',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    }
    onConnectListeners[0](port)
    expect(port.onMessage.addListener).toHaveBeenCalled()
    expect(port.onDisconnect.addListener).toHaveBeenCalled()
  })

  it('ignores ports with the wrong name', () => {
    const onConnectListeners: Array<(port: any) => void> = []
    ;(globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: (cb: any) => onConnectListeners.push(cb) },
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn(),
      },
    }
    bootKernelOffscreen({
      settings: { load: async () => ({ apiKey: 'k', baseUrl: 'b', model: 'm' }) },
      messageStore: { activeConversationId: async () => 'c', append: async () => ({ id: 'i', createdAt: 0 }), list: async () => [], update: async () => {} },
      toolContext: { build: async () => ({}) },
      tools: [],
    })
    const port = {
      name: 'something-else',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    }
    onConnectListeners[0](port)
    expect(port.onMessage.addListener).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `bootKernelOffscreen` not exported.

- [ ] **Step 3: Implement `bootKernelOffscreen`**

`packages/agent-kernel/src/browser/bootKernelOffscreen.ts`:

```ts
import { ClientCmd } from './rpc/protocol'
import { createAgentService, type AgentServiceDeps } from './agentService'
import type { SettingsAdapter } from '../adapters/SettingsAdapter'
import type { MessageStoreAdapter } from '../adapters/MessageStoreAdapter'
import type { ToolContextBuilder } from '../adapters/ToolContextBuilder'
import type { ToolDefinition } from '../core/types'

const SENTINEL_SESSION_ID = '00000000-0000-4000-8000-000000000000'

export interface BootKernelOffscreenOptions {
  settings: SettingsAdapter
  messageStore: MessageStoreAdapter
  toolContext: ToolContextBuilder
  tools: ToolDefinition<any, any, any>[]
  /** Override createAgent (tests inject fakes). */
  createAgent?: AgentServiceDeps['createAgent']
}

export function bootKernelOffscreen(opts: BootKernelOffscreenOptions): void {
  console.log('[agent-kernel/offscreen] runtime booted at', new Date().toISOString())

  let swPort: chrome.runtime.Port | null = null
  const activeAborts = new Map<string, { abort: () => void }>()
  const pendingRuntimeErrors: any[] = []

  function emit(ev: any): void {
    swPort?.postMessage(ev)
  }

  function reportRuntimeError(message: string, stack?: string) {
    const ev = {
      id: crypto.randomUUID(),
      sessionId: SENTINEL_SESSION_ID,
      ts: Date.now(),
      kind: 'runtime/error' as const,
      source: 'offscreen' as const,
      message,
      stack,
    }
    console.error('[agent-kernel/offscreen] runtime error:', message, stack ?? '')
    if (swPort) swPort.postMessage(ev)
    else pendingRuntimeErrors.push(ev)
  }

  ;(self as any).addEventListener?.('error', (e: any) => {
    reportRuntimeError(e?.message ?? 'uncaught error', e?.error?.stack)
  })
  ;(self as any).addEventListener?.('unhandledrejection', (e: any) => {
    const reason = e?.reason
    const message =
      typeof reason === 'string' ? reason : reason?.message ?? 'unhandled rejection'
    reportRuntimeError(message, reason?.stack)
  })

  const agentService = createAgentService({
    settings: opts.settings,
    emit,
    messageStore: opts.messageStore,
    toolContext: opts.toolContext,
    tools: opts.tools,
    createAgent: opts.createAgent,
  })

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sw-to-offscreen') return
    console.log('[agent-kernel/offscreen] SW connected')
    swPort = port
    while (pendingRuntimeErrors.length) port.postMessage(pendingRuntimeErrors.shift())
    port.onMessage.addListener((raw: any) => handleClientCmd(raw))
    port.onDisconnect.addListener(() => {
      console.warn('[agent-kernel/offscreen] SW disconnected')
      swPort = null
      for (const [, ac] of activeAborts) ac.abort()
      activeAborts.clear()
    })
  })

  async function handleClientCmd(raw: unknown) {
    const parsed = ClientCmd.safeParse(raw)
    if (!parsed.success) {
      console.warn(
        '[agent-kernel/offscreen] ClientCmd schema_invalid:',
        parsed.error.message,
      )
      return
    }
    const cmd = parsed.data
    console.log(
      '[agent-kernel/offscreen] cmd received:',
      cmd.kind,
      'session',
      cmd.sessionId,
    )
    switch (cmd.kind) {
      case 'chat/send':
        void runChat(cmd)
        return
      case 'chat/cancel':
        for (const [, ac] of activeAborts) ac.abort()
        activeAborts.clear()
        return
      case 'chat/newConversation':
        // Default: messageStore.activeConversationId() will lazy-create on next turn.
        // Consumers that want explicit creation can wrap their messageStore.
        return
      case 'chat/resubscribe':
        await pushSnapshot(cmd.sessionId, cmd.conversationId)
        return
      case 'ping':
        return  // hub ack handles it; offscreen no-op
      default:
        return
    }
  }

  async function runChat(cmd: { sessionId: string; text: string; system?: string; tools?: string[]; model?: string; ephemeral?: boolean }) {
    await agentService.runTurn(cmd, (cancel) => {
      activeAborts.set(cmd.sessionId, { abort: cancel })
    })
    activeAborts.delete(cmd.sessionId)
  }

  async function pushSnapshot(sessionId: string, conversationId?: string) {
    const cid = conversationId ?? (await opts.messageStore.activeConversationId())
    const messages = await opts.messageStore.list(cid)
    emit({
      id: crypto.randomUUID(),
      sessionId,
      ts: Date.now(),
      kind: 'state/snapshot',
      conversation: {
        id: cid,
        title: 'Conversation',  // consumers wanting custom titles override messageStore
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          pending: m.pending,
        })),
      },
    })
  }
}
```

- [ ] **Step 4: Re-export**

Append to `packages/agent-kernel/src/index.ts`:

```ts
export {
  bootKernelOffscreen,
  type BootKernelOffscreenOptions,
} from './browser/bootKernelOffscreen'
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun --cwd packages/agent-kernel run test bootKernelOffscreen
```

Expected: PASS — 2/2 green.

- [ ] **Step 6: Collapse mycli-web's `offscreen.ts`**

Replace the body of `packages/mycli-web/src/extension/offscreen.ts` (after the existing polyfill call) with:

```ts
// Polyfill MUST run before any kernel module touches chrome.storage / chrome.tabs.
import { polyfillChromeApiInOffscreen } from 'agent-kernel'
polyfillChromeApiInOffscreen()

import {
  bootKernelOffscreen,
  createIdbMessageStore,
  fetchGetTool,
  type ToolContextBuilder,
} from 'agent-kernel'
import { extensionTools, type ExtensionToolRpc } from '@ext-tools'
import { useSkillTool, readSkillFileTool } from '@ext-skills'
import { sendDomOp, callChromeApi } from 'agent-kernel'
import { mycliSettingsAdapter } from './settingsAdapter'

async function guessActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return tabs[0]
  } catch {
    return undefined
  }
}

const mycliToolContext: ToolContextBuilder = {
  async build(cid) {
    const tabId = (await guessActiveTab())?.id
    const rpc: ExtensionToolRpc = {
      domOp: (op, timeoutMs = 30_000) => sendDomOp(op, timeoutMs),
      chromeApi: (method, args) => callChromeApi(method, args),
    }
    return { rpc, tabId, conversationId: cid }
  },
}

bootKernelOffscreen({
  settings: mycliSettingsAdapter,
  messageStore: createIdbMessageStore({ defaultConversationTitle: 'mycli chat' }),
  toolContext: mycliToolContext,
  tools: [fetchGetTool, ...extensionTools, useSkillTool, readSkillFileTool],
})
```

That's ~30 lines. The rest of the original offscreen.ts (handleClientCmd, runChat, pushSnapshot, runtime error reporters, port management) is now provided by `bootKernelOffscreen` from the kernel.

- [ ] **Step 7: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): bootKernelOffscreen helper; mycli-web offscreen.ts collapses to ~30 lines"
```

---

### Task 14: Move heartbeat from `ChatApp` into `createAgentClient`

**Files:**
- Modify: `packages/agent-kernel/src/browser/agentClient/index.ts`
- Modify: `packages/mycli-web/src/extension/content/ChatApp.tsx`
- Modify: `packages/agent-kernel/tests/browser/agentClient/agentClient.test.ts` — add heartbeat test

- [ ] **Step 1: Write the new test for heartbeat**

Append to `packages/agent-kernel/tests/browser/agentClient/agentClient.test.ts`:

```ts
import { vi } from 'vitest'
// ... existing imports

describe('AgentClient heartbeat', () => {
  it('sends a ping every heartbeatMs (default 25000)', async () => {
    vi.useFakeTimers()
    installHub({ mode: 'offscreen-forward' })

    const sentCmds: any[] = []
    void new Promise<void>((resolve) => {
      chrome.runtime.onConnect.addListener((p) => {
        if (p.name !== 'sw-to-offscreen') return
        p.onMessage.addListener((m: any) => sentCmds.push(m))
        resolve()
      })
    })

    const agent = createAgentClient({ reconnect: false })
    // Trigger connection by sending one no-op
    agent.cancel()
    await vi.advanceTimersByTimeAsync(0)

    // Tick forward 30s; expect at least one ping
    await vi.advanceTimersByTimeAsync(26_000)
    const pings = sentCmds.filter((c) => c?.kind === 'ping')
    expect(pings.length).toBeGreaterThanOrEqual(1)

    agent.close()
    vi.useRealTimers()
  })

  it('does not send ping when heartbeatMs=0', async () => {
    vi.useFakeTimers()
    installHub({ mode: 'offscreen-forward' })
    const sentCmds: any[] = []
    void new Promise<void>((resolve) => {
      chrome.runtime.onConnect.addListener((p) => {
        if (p.name !== 'sw-to-offscreen') return
        p.onMessage.addListener((m: any) => sentCmds.push(m))
        resolve()
      })
    })
    const agent = createAgentClient({ reconnect: false, heartbeatMs: 0 })
    agent.cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    const pings = sentCmds.filter((c) => c?.kind === 'ping')
    expect(pings.length).toBe(0)
    agent.close()
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — heartbeat not implemented in createAgentClient.

- [ ] **Step 3: Add heartbeat to `createAgentClient`**

Edit `packages/agent-kernel/src/browser/agentClient/index.ts`:

Add to `CreateAgentClientOptions`:
```ts
export interface CreateAgentClientOptions {
  sessionId?: string
  reconnect?: boolean
  /** Send a no-op ping every N ms to keep the SW alive. Default 25000. Set to 0 to disable. */
  heartbeatMs?: number
}
```

Inside `createAgentClient`:

```ts
export function createAgentClient(opts: CreateAgentClientOptions = {}): AgentClient {
  const rpc = new RpcClient({
    portName: 'session',
    sessionId: opts.sessionId,
    reconnect: opts.reconnect ?? true,
  })
  let connected = false
  const heartbeatMs = opts.heartbeatMs ?? 25_000
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  async function ensureConnected(): Promise<void> {
    if (connected) return
    await rpc.connect()
    connected = true
    if (heartbeatMs > 0 && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        rpc.send({ kind: 'ping' as any }).catch(() => {})
      }, heartbeatMs)
    }
  }

  // ... existing message/oneShot/cancel implementations ...

  function close() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    rpc.disconnect()
    connected = false
  }

  // ...
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun --cwd packages/agent-kernel run test agentClient
```

Expected: PASS — heartbeat tests + existing 4 tests.

- [ ] **Step 5: Remove heartbeat from `ChatApp.tsx`**

In `packages/mycli-web/src/extension/content/ChatApp.tsx`, find the heartbeat block:

```ts
const heartbeat = setInterval(() => {
  clientRef.current?.send({ kind: 'ping' }).catch(() => {})
}, 25_000)

cleanup = () => {
  chrome.runtime.onMessage.removeListener(tabListener)
  clearInterval(heartbeat)
}
```

Replace with:

```ts
cleanup = () => {
  chrome.runtime.onMessage.removeListener(tabListener)
}
```

ChatApp also needs to switch from `new RpcClient({...})` to `createAgentClient({...})` — but that's a bigger refactor. For this task, just move heartbeat into the kernel. ChatApp will benefit when it adopts createAgentClient (out of scope).

Actually — wait. ChatApp uses `RpcClient` directly, not `createAgentClient`. The heartbeat in `createAgentClient` doesn't help ChatApp. Solution: also add an opt-in heartbeat to `RpcClient`. But that's adding API. Alternative: leave heartbeat in ChatApp as well, since ChatApp uses RpcClient directly.

Decision: keep heartbeat in BOTH places (createAgentClient for SDK consumers, ChatApp for its direct RpcClient usage). The duplication is small and reflects two different API surfaces. Update plan: skip the ChatApp removal step.

REVERT: keep ChatApp.tsx heartbeat unchanged.

- [ ] **Step 6: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): heartbeat in createAgentClient (default 25s; 0 disables)"
```

---

### Task 15: Add skill loaders (`viteGlobLoader`, `fsLoader`) as kernel exports

**Files:**
- Create: `packages/agent-kernel/src/skills/loaders/viteGlobLoader.ts`
- Create: `packages/agent-kernel/src/skills/loaders/fsLoader.ts`
- Create: `packages/agent-kernel/tests/skills/loaders/viteGlobLoader.test.ts`
- Modify: `packages/agent-kernel/src/index.ts`
- Modify: `packages/mycli-web/src/extension-skills/loader.ts` — re-export the kernel one (or delete + use kernel directly)
- Modify: `packages/mycli-web/scripts/agent-repl.ts` — switch to kernel's fsLoader

- [ ] **Step 1: Move `buildRegistryFromModules` from mycli-web's loader to a kernel module**

Currently `buildRegistryFromModules` lives in `packages/mycli-web/src/extension-skills/loader.ts`. The function itself is platform-neutral (just folder grouping + parseSkillMd + registry registration). It belongs in kernel.

Create `packages/agent-kernel/src/skills/loaders/viteGlobLoader.ts`:

```ts
import { SkillRegistry } from '../SkillRegistry'
import { parseSkillMd } from '../Skill'

/**
 * Build a SkillRegistry from a flat path → raw-content map. Path keys must
 * look like './skills/<skillName>/SKILL.md' or
 * './skills/<skillName>/<relPath>'. Anything outside './skills/' is ignored.
 *
 * Use this with Vite's import.meta.glob:
 *
 *   const modules = import.meta.glob('./skills/<asterisk><asterisk>/<asterisk>.md', {
 *     query: '?raw', eager: true, import: 'default',
 *   }) as Record<string, string>
 *   const registry = loadSkillsFromViteGlob(modules)
 */
export function loadSkillsFromViteGlob(
  modules: Record<string, string>,
): SkillRegistry {
  const PREFIX = './skills/'
  const byFolder = new Map<string, Record<string, string>>()
  for (const [path, content] of Object.entries(modules)) {
    if (!path.startsWith(PREFIX)) continue
    const tail = path.slice(PREFIX.length)
    const slash = tail.indexOf('/')
    if (slash < 0) continue
    const folder = tail.slice(0, slash)
    const rel = tail.slice(slash + 1)
    if (!byFolder.has(folder)) byFolder.set(folder, {})
    byFolder.get(folder)![rel] = content
  }
  const registry = new SkillRegistry()
  const sorted = Array.from(byFolder.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  for (const [folder, files] of sorted) {
    const entryRaw = files['SKILL.md']
    if (!entryRaw) {
      throw new Error(
        `skill folder '${folder}' is missing SKILL.md at its root (found: ${Object.keys(files).join(', ') || '(none)'})`,
      )
    }
    const parsed = parseSkillMd(entryRaw, `${folder}/SKILL.md`)
    if (parsed.name !== folder) {
      throw new Error(
        `skill folder '${folder}' SKILL.md frontmatter name='${parsed.name}' must match folder name`,
      )
    }
    registry.register({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      files: {},
      meta: parsed.meta,
    })
    for (const [relPath, content] of Object.entries(files)) {
      if (relPath === 'SKILL.md') continue
      registry.addFile(folder, relPath, content)
    }
  }
  return registry
}

// Backward-compat alias for the original mycli-web export name.
export const buildRegistryFromModules = loadSkillsFromViteGlob
```

- [ ] **Step 2: Move the test**

```bash
git mv packages/mycli-web/tests/extension-skills/loader.test.ts \
       packages/agent-kernel/tests/skills/loaders/viteGlobLoader.test.ts
```

Update its import:

```ts
// Was:
import { buildRegistryFromModules } from '@ext-skills/loader'
// Now:
import { loadSkillsFromViteGlob as buildRegistryFromModules } from 'agent-kernel'
```

- [ ] **Step 3: Create the fs-based loader**

`packages/agent-kernel/src/skills/loaders/fsLoader.ts`:

```ts
import { loadSkillsFromViteGlob } from './viteGlobLoader'
import type { SkillRegistry } from '../SkillRegistry'

/**
 * Walk a directory on disk and build a SkillRegistry from the .md files
 * found inside `<root>/<skillName>/...`. Use this in CLI/Bun/Node contexts
 * where Vite's import.meta.glob isn't available.
 *
 * Uses dynamic imports of node:fs and node:path so the kernel module
 * doesn't pull node-only deps into browser bundles.
 */
export async function loadSkillsFromFs(rootDir: string): Promise<SkillRegistry> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const modules: Record<string, string> = {}
  if (!fs.existsSync(rootDir)) return loadSkillsFromViteGlob(modules)
  const walk = (dir: string, relPrefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.isFile() && ent.name.endsWith('.md')) {
        modules[`./skills/${rel}`] = fs.readFileSync(abs, 'utf-8')
      }
    }
  }
  walk(rootDir, '')
  return loadSkillsFromViteGlob(modules)
}
```

- [ ] **Step 4: Re-export both loaders**

Append to `packages/agent-kernel/src/index.ts`:

```ts
// === skill loaders (consumers pick based on env) ===
export {
  loadSkillsFromViteGlob,
  buildRegistryFromModules,
} from './skills/loaders/viteGlobLoader'
export { loadSkillsFromFs } from './skills/loaders/fsLoader'
```

- [ ] **Step 5: Update mycli-web's loader.ts**

Replace `packages/mycli-web/src/extension-skills/loader.ts` with a thin re-export:

```ts
// Backward-compat shim. Prefer importing from 'agent-kernel' directly.
export { loadSkillsFromViteGlob as buildRegistryFromModules } from 'agent-kernel'
```

Or — delete `loader.ts` entirely and update the one consumer:

```bash
git rm packages/mycli-web/src/extension-skills/loader.ts
```

And edit `packages/mycli-web/src/extension-skills/index.ts` — change:

```ts
import { loadSkillsFromViteGlob } from 'agent-kernel'  // was: from './loader'
// ...
const registry = loadSkillsFromViteGlob(modules)
```

- [ ] **Step 6: Update agent-repl to use kernel's fsLoader**

`packages/mycli-web/scripts/agent-repl.ts`:

Replace the inline `loadSkillsFromDisk` function with a call to the kernel:

```ts
import { loadSkillsFromFs } from 'agent-kernel'

// At top-level setup (replacing loadSkillsFromDisk):
const skillsRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'src',
  'extension-skills',
  'skills',
)
const skillRegistry = await loadSkillsFromFs(skillsRoot)
```

(Remove the inline `loadSkillsFromDisk` definition and its imports of `buildRegistryFromModules`.)

- [ ] **Step 7: Run all checks**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
# Smoke test the REPL still works:
printf "/exit\n" | bun --cwd packages/mycli-web run agent:repl
```

The REPL should boot without error.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): skill loaders (viteGlob + fs) exported from kernel"
```

---

## Phase 3 — Tier 1 stability (3 tasks)

### Task 16: Add configurable LLM fetch timeout to `OpenAICompatibleClient`

**Files:**
- Modify: `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`
- Create: `packages/agent-kernel/tests/core/openAiClientTimeout.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/agent-kernel/tests/core/openAiClientTimeout.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAICompatibleClient } from 'agent-kernel'

describe('OpenAICompatibleClient fetch timeout', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('aborts the request after fetchTimeoutMs and surfaces a timeout error', async () => {
    // Mock fetch that never resolves
    globalThis.fetch = vi.fn((_url: any, init: any) => {
      return new Promise((resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted') as any
            err.name = 'AbortError'
            reject(err)
          })
        }
      })
    }) as any

    const client = new OpenAICompatibleClient({
      apiKey: 'test',
      baseUrl: 'http://x.local',
      model: 'm',
      fetchTimeoutMs: 100,
    })

    const start = Date.now()
    let caught: any
    try {
      const stream = client.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
      })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of stream) {
        // shouldn't get here
      }
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)  // honored timeout, didn't wait forever
    expect(caught).toBeDefined()
    expect(String(caught?.message ?? caught)).toMatch(/timeout|abort/i)
  })

  it('does not abort if fetchTimeoutMs is 0', async () => {
    let didAbort = false
    globalThis.fetch = vi.fn((_url: any, init: any) => {
      return new Promise(() => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            didAbort = true
          })
        }
      })
    }) as any

    const client = new OpenAICompatibleClient({
      apiKey: 'test',
      baseUrl: 'http://x.local',
      model: 'm',
      fetchTimeoutMs: 0,
    })
    const stream = client.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
    })
    // Race against a short timer; we expect the iteration not to abort within 200ms
    let gotEvent = false
    const racer = (async () => {
      for await (const _ev of stream) {
        gotEvent = true
      }
    })()
    await new Promise((r) => setTimeout(r, 200))
    expect(didAbort).toBe(false)
    expect(gotEvent).toBe(false)
    // Cleanup: nothing — fetch promise hangs forever; vitest will move on
  }, 1000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — fetchTimeoutMs option not yet supported.

- [ ] **Step 3: Implement timeout**

Edit `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`:

Add `fetchTimeoutMs` to `ClientConfig`:

```ts
export interface ClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  /**
   * Hard timeout in ms for the LLM fetch. Default 60_000. Set to 0 to disable
   * (fetch hangs indefinitely on unresponsive endpoints).
   */
  fetchTimeoutMs?: number
}
```

Inside `streamChat`, before `const res = await fetch(url, {...})`:

```ts
const timeoutMs = this.cfg.fetchTimeoutMs ?? 60_000
const timeoutController = timeoutMs > 0 ? new AbortController() : undefined
const timeoutId =
  timeoutMs > 0 && timeoutController
    ? setTimeout(() => timeoutController.abort(new Error('llm fetch timeout')), timeoutMs)
    : undefined

// Combine consumer signal with our timeout controller
const combinedSignal = combineSignals(req.signal, timeoutController?.signal)

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
  body: JSON.stringify(body),
  signal: combinedSignal,
}).catch((e) => {
  if (timeoutController?.signal.aborted) {
    throw new Error(`LLM fetch timeout after ${timeoutMs}ms`)
  }
  throw e
})
if (timeoutId) clearTimeout(timeoutId)
```

Add `combineSignals` helper at the top of the file:

```ts
function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  const ctrl = new AbortController()
  for (const s of live) {
    if (s.aborted) {
      ctrl.abort(s.reason)
      return ctrl.signal
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true })
  }
  return ctrl.signal
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun --cwd packages/agent-kernel run test openAiClientTimeout
```

Expected: PASS — 2/2.

- [ ] **Step 5: Run full kernel test suite**

```bash
bun --cwd packages/agent-kernel run test
```

All previous tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): configurable fetchTimeoutMs on OpenAICompatibleClient (default 60s)"
```

---

### Task 17: Add `ErrorCode` enum + `classifyError` helper

**Files:**
- Create: `packages/agent-kernel/src/errors.ts`
- Create: `packages/agent-kernel/tests/core/classifyError.test.ts`
- Modify: `packages/agent-kernel/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/agent-kernel/tests/core/classifyError.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ErrorCode, classifyError } from 'agent-kernel'

describe('classifyError', () => {
  it('classifies AbortError as Abort', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Abort)
    expect(c.retryable).toBe(false)
  })

  it('classifies LLM HTTP 401 as Auth', () => {
    const err = Object.assign(new Error('LLM HTTP 401'), { status: 401 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Auth)
    expect(c.retryable).toBe(false)
  })

  it('classifies LLM HTTP 429 as RateLimit (retryable)', () => {
    const err = Object.assign(new Error('LLM HTTP 429'), { status: 429 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.RateLimit)
    expect(c.retryable).toBe(true)
  })

  it('classifies LLM HTTP 500-599 as Server (retryable)', () => {
    const err = Object.assign(new Error('LLM HTTP 503'), { status: 503 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Server)
    expect(c.retryable).toBe(true)
  })

  it('classifies LLM HTTP 4xx (other) as BadRequest', () => {
    const err = Object.assign(new Error('LLM HTTP 400'), { status: 400 })
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.BadRequest)
    expect(c.retryable).toBe(false)
  })

  it('classifies messages with "timeout" as Timeout (retryable)', () => {
    const err = new Error('LLM fetch timeout after 60000ms')
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Timeout)
    expect(c.retryable).toBe(true)
  })

  it('classifies TypeError fetch failures as Network (retryable)', () => {
    const err = new TypeError('fetch failed')
    const c = classifyError(err)
    expect(c.code).toBe(ErrorCode.Network)
    expect(c.retryable).toBe(true)
  })

  it('falls back to Unknown for non-Error values', () => {
    const c = classifyError('weird string')
    expect(c.code).toBe(ErrorCode.Unknown)
    expect(c.message).toContain('weird string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `ErrorCode` and `classifyError` not exported.

- [ ] **Step 3: Implement**

`packages/agent-kernel/src/errors.ts`:

```ts
export enum ErrorCode {
  Network = 'network',
  Auth = 'auth',
  RateLimit = 'rate_limit',
  BadRequest = 'bad_request',
  Server = 'server',
  Timeout = 'timeout',
  Abort = 'abort',
  ToolError = 'tool_error',
  Schema = 'schema',
  Unknown = 'unknown',
}

export interface ClassifiedError {
  code: ErrorCode
  message: string
  retryable: boolean
  cause?: unknown
}

export function classifyError(e: unknown): ClassifiedError {
  // AbortError
  if (e && typeof e === 'object' && (e as any).name === 'AbortError') {
    return { code: ErrorCode.Abort, message: 'aborted', retryable: false, cause: e }
  }

  // Errors with a numeric `status` (set by OpenAICompatibleClient on HTTP failures)
  const status = (e as any)?.status as number | undefined
  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return {
        code: ErrorCode.Auth,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: false,
        cause: e,
      }
    }
    if (status === 429) {
      return {
        code: ErrorCode.RateLimit,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: true,
        cause: e,
      }
    }
    if (status >= 500 && status < 600) {
      return {
        code: ErrorCode.Server,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: true,
        cause: e,
      }
    }
    if (status >= 400 && status < 500) {
      return {
        code: ErrorCode.BadRequest,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: false,
        cause: e,
      }
    }
  }

  // Message-pattern matching
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : JSON.stringify(e)
  if (/timeout/i.test(msg)) {
    return { code: ErrorCode.Timeout, message: msg, retryable: true, cause: e }
  }
  if (e instanceof TypeError && /fetch/i.test(msg)) {
    return { code: ErrorCode.Network, message: msg, retryable: true, cause: e }
  }

  return {
    code: ErrorCode.Unknown,
    message: typeof msg === 'string' ? msg : String(msg),
    retryable: false,
    cause: e,
  }
}
```

- [ ] **Step 4: Re-export**

Append to `packages/agent-kernel/src/index.ts`:

```ts
export { ErrorCode, classifyError, type ClassifiedError } from './errors'
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun --cwd packages/agent-kernel run test classifyError
```

Expected: PASS — 8/8.

- [ ] **Step 6: Run full suite**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): ErrorCode taxonomy + classifyError helper"
```

---

### Task 18: Wire `classifyError` into `OpenAICompatibleClient` and surface in `AgentEvent.done.error`

**Files:**
- Modify: `packages/agent-kernel/src/core/OpenAICompatibleClient.ts`
- Modify: `packages/agent-kernel/src/core/QueryEngine.ts`
- Update relevant tests if they assert on error message text

- [ ] **Step 1: Wrap thrown errors with `classifyError` inside OpenAICompatibleClient**

In `streamChat`, wrap the catch on the fetch/reader path:

```ts
import { classifyError } from '../errors'

// inside streamChat, after the fetch+reader logic, on any catch:
} catch (e) {
  const classified = classifyError(e)
  const wrappedError = Object.assign(new Error(classified.message), {
    code: classified.code,
    retryable: classified.retryable,
    cause: classified.cause,
  })
  throw wrappedError
}
```

(For HTTP non-200 responses where we currently throw `Object.assign(new Error('LLM HTTP ${status}'), { status, detail })`, the classified error will pick up the `status` field and produce the right code.)

- [ ] **Step 2: Forward classified info through `done` event in QueryEngine**

In `packages/agent-kernel/src/core/QueryEngine.ts`, look for the catch that yields `done` with `stopReason: 'error'`:

```ts
} catch (e: any) {
  const msg = e?.message ?? String(e)
  yield {
    kind: 'done',
    stopReason: 'error',
    error: {
      code: e?.code ?? 'llm_error',  // <-- now carries classified code
      message: msg,
    },
  }
  return
}
```

- [ ] **Step 3: Run all tests**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck && bun --cwd packages/agent-kernel run test && bun --cwd packages/mycli-web run test && bun --cwd packages/mycli-web run build
```

If any existing test asserts on the exact error code string, update it. Most tests should still pass since the SHAPE of the error is unchanged — only the `code` field gets enriched.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(agent-kernel): OpenAICompatibleClient wraps errors via classifyError; QueryEngine forwards code"
```

---

## Phase 4 — Documentation (5 tasks)

### Task 19: Write `packages/agent-kernel/README.md`

**Files:**
- Create: `packages/agent-kernel/README.md`

- [ ] **Step 1: Write the README**

```markdown
# agent-kernel

A reusable agent kernel for Chrome MV3 extensions. Bundle the LLM loop, tool
protocol, skills, RPC, and SW/offscreen plumbing into your extension via a
small assembly-kit API.

## What it provides

- **Agent loop** — `createAgent`, `AgentSession`, `QueryEngine` (OpenAI-compatible)
- **Tool protocol** — `ToolDefinition`, `ToolRegistry`, `makeOk`/`makeError`,
  ships `fetchGetTool` as the only generic built-in
- **Skills** — `SkillRegistry`, `parseSkillMd`, `useSkill` / `readSkillFile`
  meta-tool factories, plus loaders (`loadSkillsFromViteGlob`,
  `loadSkillsFromFs`)
- **Browser RPC** — content↔SW↔offscreen plumbing (`installHub`, `RpcClient`,
  port + broadcast transports)
- **Assembly helpers** — `installKernelBackground`, `bootKernelOffscreen`,
  `createAgentClient`
- **Adapters** for consumer-supplied bits — `SettingsAdapter`,
  `MessageStoreAdapter`, `ToolContextBuilder`
- **Stability primitives** — configurable LLM fetch timeout, `ErrorCode`
  taxonomy, runtime-error forwarding to F12, SW heartbeat in `createAgentClient`

## What it does NOT provide

- UI components (no React widgets) — bring your own chat surface
- Settings persistence — implement `SettingsAdapter` how you like
- Specific browser tools (DOM ops, screenshots, etc.) — those are
  consumer-specific
- Skill content (`.md` files) — consumers ship their own
- Provider adapters other than OpenAI-compatible (deliberate, for now)

## 5-minute quickstart

See [`docs/getting-started.md`](./docs/getting-started.md).

## Workspace dep

Inside this monorepo, declare:

```json
"dependencies": {
  "agent-kernel": "workspace:*"
}
```

Then `bun install` from the workspace root.

## Reference consumer

`packages/mycli-web/` is a complete reference extension that uses this kernel.
Look at its `background.ts`, `offscreen.ts`, `extension-tools/`, and
`extension-skills/` for the full pattern.
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent-kernel/README.md
git commit -m "docs(agent-kernel): README"
```

---

### Task 20: Write `packages/agent-kernel/docs/getting-started.md`

**Files:**
- Create: `packages/agent-kernel/docs/getting-started.md`

- [ ] **Step 1: Write the guide**

```markdown
# Getting started

Build a minimal Chrome MV3 extension that uses agent-kernel.

## Prerequisites

- Bun ≥ 1.3.5
- Chrome 116+ (for MV3 + offscreen API)
- An OpenAI-compatible LLM endpoint (key + URL + model)

## Set up the workspace

This guide assumes your extension lives in the same monorepo as agent-kernel.
If not, `bun add agent-kernel` from your extension's package and adjust paths.

## 1. Manifest + Vite

Standard MV3 setup with @crxjs/vite-plugin. See
`packages/mycli-web/manifest.json` and `vite.config.ts` for a working example.
The kernel doesn't dictate the manifest — declare your own permissions, content
scripts, etc.

## 2. Background script (background.ts) — ~10 lines

```ts
import { installKernelBackground } from 'agent-kernel'

installKernelBackground({
  offscreenUrl: chrome.runtime.getURL('html/offscreen.html'),
  offscreenReason: 'IFRAME_SCRIPTING' as chrome.offscreen.Reason,
  hubMode: 'offscreen-forward',
  toggleCommand: 'toggle-chat',
})
```

That's the entire SW. Kernel handles hub install, dom op routing, action click,
keyboard command, runtime error forwarding.

## 3. Offscreen (offscreen.ts) — ~30 lines

```ts
import {
  bootKernelOffscreen,
  createIdbMessageStore,
  fetchGetTool,
  polyfillChromeApiInOffscreen,
  type ToolContextBuilder,
  type SettingsAdapter,
} from 'agent-kernel'

polyfillChromeApiInOffscreen()

const settings: SettingsAdapter = {
  async load() {
    const r = await chrome.storage.local.get('mySettings')
    return r.mySettings ?? { apiKey: '', baseUrl: '', model: '' }
  },
}

const toolContext: ToolContextBuilder = {
  async build(cid) {
    return { conversationId: cid }
  },
}

bootKernelOffscreen({
  settings,
  messageStore: createIdbMessageStore(),
  toolContext,
  tools: [fetchGetTool /* + your tools */],
})
```

## 4. Content script (content.ts) — talk to the agent

```ts
import { createAgentClient } from 'agent-kernel'

const agent = createAgentClient()

document.querySelector('#send')?.addEventListener('click', async () => {
  const text = (document.querySelector<HTMLInputElement>('#input')!).value
  for await (const ev of agent.message({ text })) {
    if (ev.kind === 'message/streamChunk') {
      // append ev.delta to your UI
    }
  }
})
```

## 5. Add a tool

Drop a `ToolDefinition` into the `tools` array in step 3:

```ts
import { type ToolDefinition, makeOk, makeError } from 'agent-kernel'

const echoTool: ToolDefinition<{ text: string }, { echoed: string }, any> = {
  name: 'echo',
  description: 'Echoes its input.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(input) {
    if (!input?.text) return makeError('invalid', 'text required')
    return makeOk({ echoed: input.text })
  },
}

// Then: tools: [fetchGetTool, echoTool]
```

## 6. Add skills

```bash
mkdir -p src/skills/summarize
cat > src/skills/summarize/SKILL.md <<'EOF'
---
name: summarize
description: Summarize the user's input in three bullet points.
---

# Instructions
1. Read the user's input.
2. Identify the three most important points.
3. Reply with a markdown bullet list. Bold each key term.
EOF
```

Then in offscreen.ts:

```ts
import {
  loadSkillsFromViteGlob,
  createUseSkillTool,
  createReadSkillFileTool,
} from 'agent-kernel'

const skillModules = import.meta.glob('./skills/**/*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>
const skillRegistry = loadSkillsFromViteGlob(skillModules)
const useSkill = createUseSkillTool({ registry: skillRegistry })
const readSkillFile = createReadSkillFileTool({ registry: skillRegistry })

bootKernelOffscreen({
  // ... settings, messageStore, toolContext, ...
  tools: [fetchGetTool, echoTool, useSkill, readSkillFile],
})
```

The LLM now sees `useSkill` in its tool list and can load `summarize` on demand.

## What's next

- [API reference](./api-reference.md) — every public symbol and shape
- [Adapters guide](./adapters.md) — implementing custom storage / settings
- [Error handling](./error-handling.md) — ErrorCode taxonomy and runtime/error events
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent-kernel/docs/getting-started.md
git commit -m "docs(agent-kernel): getting-started guide"
```

---

### Task 21: Write `packages/agent-kernel/docs/api-reference.md`

**Files:**
- Create: `packages/agent-kernel/docs/api-reference.md`

- [ ] **Step 1: Write the API reference**

```markdown
# API reference

All public symbols are exported from the package root: `import { ... } from 'agent-kernel'`.

## Agent loop

### `createAgent(opts: CreateAgentOptions): AgentSession`

Constructs an agent session. See `AgentSession.send` for usage.

```ts
const agent = createAgent({
  llm: { apiKey, baseUrl, model, fetchTimeoutMs: 60_000 },
  tools: [...],
  toolContext: {},
  systemPrompt: 'You are helpful.',
  toolMaxIterations: 50,
})
```

### `AgentSession`

#### `send(text, opts?): AsyncIterable<AgentEvent>`

Yields events as the turn progresses. Terminates on `kind: 'done'`.

#### `cancel(): void`

Aborts the in-flight turn. Subsequent `send` calls reset the abort controller.

## Adapters

### `SettingsAdapter`

```ts
interface SettingsAdapter {
  load(): Promise<Settings>
}
interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  systemPromptAddendum?: string
  toolMaxIterations?: number
}
```

### `MessageStoreAdapter`

```ts
interface MessageStoreAdapter {
  activeConversationId(): Promise<string>
  append(msg: AppendMessageInput): Promise<AppendedMessage>
  list(conversationId: string): Promise<MessageRecord[]>
  update(id: string, patch: { content?: string; pending?: boolean }): Promise<void>
}
```

Default implementation: `createIdbMessageStore({ defaultConversationTitle? })` —
backed by IndexedDB DB named `agent-kernel`.

### `ToolContextBuilder`

```ts
interface ToolContextBuilder<Ctx = Record<string, unknown>> {
  build(cid: string | undefined): Promise<Ctx>
}
```

## Tools

### `ToolDefinition<I, O, ExtraCtx>`

```ts
interface ToolDefinition<I, O, ExtraCtx> {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema subset
  execute(input: I, ctx: ToolExecContext & ExtraCtx): Promise<ToolResult<O>>
}
```

`execute` MUST NOT throw — return `makeError(...)` instead.

### `makeOk<T>(data: T)`, `makeError(code, message, retryable?)`

Helpers to build `ToolResult` shapes.

### `fetchGetTool`

The only built-in tool. Performs an HTTP GET and returns the response body.

## Skills

### `SkillRegistry`

```ts
class SkillRegistry {
  register(skill: SkillDefinition): void  // throws on duplicate name
  get(name: string): SkillDefinition | undefined
  list(): SkillDefinition[]                // alphabetical
  addFile(skillName: string, relPath: string, content: string): void
}
```

### `parseSkillMd(raw, sourcePath): ParsedSkillMd`

Parses a markdown file with YAML-like frontmatter (`name`, `description` required).

### `createUseSkillTool({ registry })` / `createReadSkillFileTool({ registry })`

Returns a `ToolDefinition` whose description auto-includes the registry's
contents. Pass the resulting tool into your `bootKernelOffscreen` `tools` array.

### `loadSkillsFromViteGlob(modules)` / `loadSkillsFromFs(rootDir)`

Build a `SkillRegistry` from `.md` files. Pick based on environment.

## Assembly helpers

### `installKernelBackground(opts)`

Call from the SW entry. Sets up hub, dom op router, ensure-offscreen lifecycle,
action/command listeners, runtime error forwarding.

```ts
interface InstallKernelBackgroundOptions {
  offscreenUrl: string
  offscreenReason: chrome.offscreen.Reason
  hubMode?: 'echo' | 'offscreen-forward'    // default 'offscreen-forward'
  toggleCommand?: string                     // optional keyboard binding
  onActivate?: (tabId: number) => Promise<void>
}
```

### `bootKernelOffscreen(opts)`

Call from the offscreen entry. Boots the agent runtime — handles `chat/send`,
`chat/cancel`, `chat/resubscribe`, `ping`.

```ts
interface BootKernelOffscreenOptions {
  settings: SettingsAdapter
  messageStore: MessageStoreAdapter
  toolContext: ToolContextBuilder
  tools: ToolDefinition[]
  createAgent?: typeof defaultCreateAgent  // for tests
}
```

### `createAgentClient(opts?)`

Returns an `AgentClient` with `message`, `oneShot`, `cancel`, `close`. Use in
content/options/popup contexts. Auto-heartbeat keeps SW alive.

```ts
interface CreateAgentClientOptions {
  sessionId?: string
  reconnect?: boolean         // default true
  heartbeatMs?: number        // default 25_000; 0 = disable
}
```

## Errors

### `ErrorCode` enum

```ts
enum ErrorCode {
  Network, Auth, RateLimit, BadRequest, Server,
  Timeout, Abort, ToolError, Schema, Unknown,
}
```

### `classifyError(e: unknown): ClassifiedError`

```ts
interface ClassifiedError {
  code: ErrorCode
  message: string
  retryable: boolean
  cause?: unknown
}
```

LLM `done` events with `stopReason: 'error'` carry `error.code` matching
this enum.

## Browser RPC (low-level)

Most consumers don't need these. Use `createAgentClient` instead.

- `installHub({ mode })` — registers SW hub
- `RpcClient` — direct port-based client (manual lifecycle)
- `ClientCmd`, `WireAgentEvent` — Zod schemas

## Polyfill

### `polyfillChromeApiInOffscreen()`

MUST be called at the very top of the offscreen entry, before any module
touches `chrome.storage` or `chrome.tabs`. Some Chrome versions don't expose
those APIs in offscreen documents; the polyfill proxies through the SW.
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent-kernel/docs/api-reference.md
git commit -m "docs(agent-kernel): API reference"
```

---

### Task 22: Write `packages/agent-kernel/docs/adapters.md`

**Files:**
- Create: `packages/agent-kernel/docs/adapters.md`

- [ ] **Step 1: Write the guide**

```markdown
# Adapters guide

The kernel exposes three adapter interfaces. Implementing them lets you plug
your own storage / settings / tool-context strategy in without modifying the
kernel.

## SettingsAdapter

The kernel needs current LLM credentials and a few knobs each turn. It calls
`adapter.load()` once per `runTurn`.

### Storage examples

**chrome.storage.local** (typical extension):
```ts
const adapter: SettingsAdapter = {
  async load() {
    const r = await chrome.storage.local.get('settings')
    return {
      apiKey: r.settings?.apiKey ?? '',
      baseUrl: r.settings?.baseUrl ?? 'https://api.openai.com/v1',
      model: r.settings?.model ?? 'gpt-4o-mini',
    }
  },
}
```

**Hard-coded** (for prototypes):
```ts
const adapter: SettingsAdapter = {
  async load() {
    return { apiKey: 'sk-…', baseUrl: '…', model: 'gpt-4o-mini' }
  },
}
```

**Cloud sync**:
```ts
const adapter: SettingsAdapter = {
  async load() {
    const res = await fetch('https://config.your-team/api/agent-settings')
    return res.json()
  },
}
```

## MessageStoreAdapter

Persists the conversation history. Kernel default is IDB; consumer can
substitute anything that implements the four methods.

### When to override the default

- You want a different DB / backing store
- You want server-side persistence
- You want in-memory only (no persistence)
- You want consolidated storage across multiple kernel-using extensions

### Example: in-memory store

```ts
function createMemoryStore(): MessageStoreAdapter {
  const messages: MessageRecord[] = []
  let convId: string | undefined
  return {
    async activeConversationId() {
      if (!convId) convId = crypto.randomUUID()
      return convId
    },
    async append(msg) {
      const rec: MessageRecord = {
        id: crypto.randomUUID(),
        role: msg.role,
        content: msg.content,
        createdAt: Date.now(),
        pending: msg.pending,
      }
      messages.push(rec)
      return { id: rec.id, createdAt: rec.createdAt }
    },
    async list(cid) {
      return messages.filter(() => cid === convId)
    },
    async update(id, patch) {
      const m = messages.find((x) => x.id === id)
      if (m) Object.assign(m, patch)
    },
  }
}
```

## ToolContextBuilder

The agent calls `toolContext.build(cid)` once per turn and merges the returned
object into every tool's `ctx` parameter.

### Why an adapter?

The kernel doesn't know what fields YOUR tools need. Browser tools usually
want `tabId` + an RPC for DOM ops; server-side tools might want a database
client; CLI tools might want process env. The adapter lets you supply
whatever your tools expect.

### Example: chrome backend

```ts
const builder: ToolContextBuilder = {
  async build(cid) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return {
      tabId: tabs[0]?.id,
      conversationId: cid,
      rpc: { domOp, chromeApi },  // your RPC helpers
    }
  },
}
```

### Example: empty (for tools that need no extras)

```ts
const builder: ToolContextBuilder = { async build() { return {} } }
```

## Composing all three

```ts
import {
  bootKernelOffscreen,
  createIdbMessageStore,
  fetchGetTool,
  type SettingsAdapter,
  type ToolContextBuilder,
} from 'agent-kernel'

const settings: SettingsAdapter = { /* ... */ }
const toolContext: ToolContextBuilder = { /* ... */ }

bootKernelOffscreen({
  settings,
  messageStore: createIdbMessageStore({ defaultConversationTitle: 'My Agent' }),
  toolContext,
  tools: [fetchGetTool /* + your tools */],
})
```
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent-kernel/docs/adapters.md
git commit -m "docs(agent-kernel): adapters guide"
```

---

### Task 23: Update root `CLAUDE.md`, `architecture.md`, `agent-integration.md` to reflect new workspace shape

**Files:**
- Modify: `CLAUDE.md` (root)
- Modify: `docs/architecture.md`
- Modify: `docs/agent-integration.md`

- [ ] **Step 1: Update root `CLAUDE.md`**

Find the section describing the project layout (lines describing `mycli-web/`). Update to describe the new workspace:

```md
## Workspace layout

Bun workspace with two packages:

- **`packages/agent-kernel/`** — the reusable agent kernel library. Platform-aware (browser-only) but extension-agnostic. Provides agent loop, RPC, skills, assembly helpers, adapters. Internal only (not published to npm).
- **`packages/mycli-web/`** — the reference Chrome extension consuming agent-kernel. Provides UI, settings UI, business tools, skill content.

Inside each package, `CLAUDE.md` (if present) gives package-specific guidance. Read both before editing across packages.

Build/test/typecheck commands run from the workspace root or per-package via `bun --cwd packages/<name> run <script>`.
```

- [ ] **Step 2: Rewrite `docs/architecture.md`**

Replace its body with a new architecture overview:

(See the "architecture" section of the spec doc — port that diagram and prose.)

Key sections:
- Two-package overview
- Kernel layers (core / browser / skills / adapters)
- Reference consumer layout
- Cross-package data flow diagram
- IDB namespace strategy

- [ ] **Step 3: Update `docs/agent-integration.md`**

Now that the kernel is a separate package, the integration doc should pivot from "edit files in this repo" to "depend on agent-kernel and follow the assembly pattern". Update:

- Section 1 ("Framework 是什么"): describe agent-kernel as a workspace dep
- Section 2 (decision tree): paths point to packages/mycli-web for adding tools/skills
- Section 3.1-3.5 (scenarios): update import paths from `@core` / `@ext-tools` to `agent-kernel`
- Section 4 (types speedrun): point at packages/agent-kernel/docs/api-reference.md
- Section 5 (errors): point at packages/agent-kernel/docs/error-handling.md (if it exists; otherwise classifyError docs in api-reference)
- Section 9 (file index): update paths

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture.md docs/agent-integration.md
git commit -m "docs: update architecture + integration guides for workspace + kernel"
```

---

## Phase 5 — Final verification (2 tasks)

### Task 24: Run full validation matrix

**Files:** none — only running commands.

- [ ] **Step 1: Workspace-wide typecheck**

```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck
```

Expected: PASS, exit 0.

- [ ] **Step 2: Kernel test suite**

```bash
bun --cwd packages/agent-kernel run test
```

Expected: all green. Test count should be ~80+ (core + skills + browser + adapters).

- [ ] **Step 3: Consumer test suite**

```bash
bun --cwd packages/mycli-web run test
```

Expected: all green. ~50+ tests (UI/storage/extension-skills/extension-tools that stayed).

- [ ] **Step 4: Production build**

```bash
bun --cwd packages/mycli-web run build
```

Expected: PASS. `dist/` populated.

- [ ] **Step 5: REPL smoke test**

```bash
printf "/exit\n" | bun --cwd packages/mycli-web run agent:repl
```

Expected: REPL boots, lists tools (including `useSkill` and `readSkillFile`), exits cleanly.

- [ ] **Step 6: Live skill flow test (if API key available)**

```bash
MYCLI_TEST_API_KEY="…" \
MYCLI_TEST_BASE_URL="…" \
MYCLI_TEST_MODEL="…" \
bun --cwd packages/mycli-web run test tests/integration/agent.live.test.ts -t "skill flow"
```

Expected: PASS in <60s.

- [ ] **Step 7: No commit needed if everything green**

If anything failed, fix the specific issue and commit the fix.

---

### Task 25: Manual browser smoke test (human checklist)

**Files:** none — manual.

This task verifies the actual extension works in Chrome, since automated tests
don't cover the full SW + offscreen + content interactions in a real browser.

- [ ] **Step 1: Build**

```bash
bun --cwd packages/mycli-web run build
```

- [ ] **Step 2: Reload extension in Chrome**

`chrome://extensions` → mycli-web → reload icon

- [ ] **Step 3: Open a fresh tab**

Navigate to `https://example.com`. Hard-refresh (`Cmd+Shift+R`) to ensure
fresh content script.

- [ ] **Step 4: Open chat (FAB or `Cmd+Shift+K`)**

- [ ] **Step 5: Send "Hello" — verify normal turn works**

- [ ] **Step 6: Send "Use the summarizePage skill on this page" — verify skill flow works**

Expected:
- LLM calls `useSkill({skill:'summarizePage'})`
- LLM calls `readPage({mode:'text'})`
- LLM produces 3-bullet summary
- F12 console shows no errors

- [ ] **Step 7: Wait 3 minutes idle, then send another message — verify SW kept alive**

Heartbeat should prevent the post-skill ack_timeout regression.

- [ ] **Step 8: Open SW DevTools and verify**

`chrome://extensions` → "Inspect views: service worker"

Should show:
- `[agent-kernel] background SW booted`
- `[mycli-web/hub] cmd ping session …` every 25s (heartbeat)
- `[mycli-web/hub] cmd chat/send …` for each user message

- [ ] **Step 9: Open offscreen DevTools and verify**

Same Inspect views — pick `offscreen.html`.

Should show:
- `[agent-kernel/offscreen] runtime booted at …`
- `[agent-kernel/offscreen] cmd received: chat/send …` for each turn
- `[mycli-web/agent] runTurn start, text: …`
- `[mycli-web/agent] settings loaded; apiKey set: true …`

If all 8 checks pass — kernel extraction is complete and the reference
consumer works.

---

## Self-Review Checklist (run by the implementer at the end)

- [ ] **Spec coverage** — every section of `2026-05-10-agent-kernel-extraction-design.md` has at least one task that implements it:
  - Workspace layout → Tasks 1-2
  - Kernel公开 API surface → Tasks 3-15 build it incrementally
  - Adapter interfaces → Tasks 9-11
  - 装配 helper → Tasks 12-13
  - Skill loaders → Task 15
  - Settings adapter → Task 9
  - 命名空间隔离 (IDB) → Task 7 step 2
  - Tier 1 stability (fetch timeout) → Task 16
  - Tier 1 stability (ErrorCode) → Tasks 17-18
  - Tier 1 stability (heartbeat in SDK) → Task 14
  - Public/private API 边界 → handled by `index.ts` discipline throughout
  - Documentation → Tasks 19-23
  - 接受标准 → Task 24-25 verify
- [ ] **Placeholder scan** — no `TODO`, `TBD`, `placeholder`, `xxx` strings. (`unused/skills/skillData` deletion in Task 7 step 5 is conditional but specified.)
- [ ] **Type consistency**:
  - `Settings`, `SettingsAdapter` defined once (Task 9), consistent in 10/11/12/13
  - `MessageStoreAdapter` shape consistent in Task 10 spec + Task 13 usage
  - `ToolContextBuilder` shape consistent in Task 11 + 13
  - `BootKernelOffscreenOptions` matches what the offscreen entry uses (Task 13 step 6)
  - `InstallKernelBackgroundOptions` matches what background entry uses (Task 12 step 6)
- [ ] **Migration safety** — every task ends with the same 4-command verify. No task can leave the workspace in a broken state.
- [ ] **Backward-compat shims** — Task 15 preserves `buildRegistryFromModules` as alias so any out-of-tree consumer keeps working.
- [ ] **Consumer obligations** documented — README + getting-started + adapters cover what the consumer must provide.

If any unchecked box can't be ticked, fix in place and re-check.
