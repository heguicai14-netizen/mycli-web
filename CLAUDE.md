# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mycli-web` is a Chrome MV3 browser-agent extension forked from a CLI agent (`mycli`) and rebuilt web-first. The user chats with an OpenAI-compatible LLM via a Shadow-DOM floating window injected into any page; the agent has browser tools (DOM read/write, tabs, screenshots, fetch) and is being grown toward sub-agents and user-installable skills (some skill code runs in sandbox iframes). Project is plan-driven.

Design of record: `docs/superpowers/specs/2026-04-24-mycli-web-design.md`. Phased plans in `docs/superpowers/plans/` (currently Plan A scaffolding + Plan B agent core).

## Commands

```bash
bun install
bun run build          # vite + @crxjs/vite-plugin → dist/ (load unpacked in chrome://extensions)
bun run dev            # vite dev server (HMR; less commonly used since this is an extension)
bun run test           # vitest run (jsdom + fake-indexeddb + chrome.* mock)
bun run test:watch
bun run typecheck      # tsc -p tsconfig.json --noEmit
```

Run a single test file: `bun run test tests/rpc/hub.test.ts`. Run a single case: `bun run test -t "name fragment"`.

Requires **bun ≥ 1.3.5** and **Node ≥ 24**. Test setup (`tests/setup.ts`) auto-installs `fake-indexeddb` and re-installs the chrome.* mock in `beforeEach` — tests don't need to do that themselves.

## Architecture

### Four process boundaries

The extension is split across four contexts that **cannot share memory** and only talk via Chrome message-passing. Knowing which context a file belongs to is essential before editing it.

| Context | Lifetime | Responsibility | Never does |
|---|---|---|---|
| **Content script** (`src/extension/content/`, one per tab) | Page load → navigation | Shadow-DOM React UI (chat window, FAB), DOM ops on its own page | Holds agent state, calls LLM, talks to skill sandboxes |
| **Service Worker** (`src/extension/background.ts`, ≤1 instance, easily suspended) | Event-driven | RPC routing, `chrome.*` proxy, offscreen-document lifecycle, keyboard command handler | Runs the agent loop, holds long-lived state |
| **Offscreen document** (`src/extension/offscreen.ts`, ≤1 instance, kept alive while needed) | Created on first activation by SW | `QueryEngine` agent loop, tool dispatch, IndexedDB I/O, hosts skill sandbox iframes | DOM mutations on user pages, UI rendering |
| **Sandbox iframe** (per code-skill, future) | Child of offscreen | Executes a skill's `tools.js` in a null-origin sandbox | Touches `chrome.*`, parent DOM, or extension storage |

A single conversation flows: user types in content script → port `session` → SW hub → port `sw-to-offscreen` → offscreen QueryEngine → LLM → tool dispatch → (back through the same chain).

### Two transports — don't confuse them

There are two transport paths in the codebase, both in active use:

1. **Long-lived ports** carry chat traffic: `RpcClient` (in content) opens `chrome.runtime.connect({ name: 'session' })`, the hub in SW (`installHub`) accepts it and opens its own port to the offscreen doc (`name: 'sw-to-offscreen'`). All such messages are validated against the Zod `ClientCmd` / `AgentEvent` schemas in `src/extension/rpc/protocol.ts`.
2. **One-shot `chrome.runtime.sendMessage` broadcasts** carry tool-execution side traffic: when the offscreen doc needs to do a DOM op or a `chrome.*` call, it broadcasts a `dom_op_request` / `chrome_api_request`, the SW (`background.ts` listener) handles it, then broadcasts a `*_result` message back. The offscreen `sendDomOp` / `callChromeApi` helpers correlate by a randomly generated `id`. This bypasses the port and is **not** Zod-validated — keep payload shapes consistent with the existing handlers.

When adding a new tool, decide which transport it needs based on `ToolDefinition.exec`:
- `exec: 'content'` → tool calls `ctx.rpc.domOp(...)` (uses the broadcast transport, ends up in `domHandlers.ts` in the target tab)
- `exec: 'sw'` → tool calls `ctx.rpc.chromeApi(...)` (handled in `background.ts` `handleChromeApi`; you'll need to add a case there for any new method)
- `exec: 'offscreen'` → tool runs purely inside offscreen, no RPC needed

### Storage split

Two storage layers, used for different things — don't conflate:

- **IndexedDB** (`src/extension/storage/db.ts` plus per-store wrappers): durable conversation/message history, installed skills, audit log. Schema is versioned (`DB_VERSION`) — add an `if (oldVersion < N)` branch in `openDb`'s `upgrade` callback when extending.
- **`chrome.storage.local`** for Zod-validated settings (`storage/settings.ts`) and approval rules (`storage/rules.ts`).
- **`chrome.storage.session`** for transient UI state (`storage/transient.ts`). Note: the SW widens its access level to `TRUSTED_AND_UNTRUSTED_CONTEXTS` at boot so content scripts can read it — don't remove that call.

### Vite quirk: offscreen.html must be an explicit input

`html/offscreen.html` is loaded via `chrome.offscreen.createDocument` rather than referenced from `manifest.json`, so `@crxjs/vite-plugin` won't discover it. `vite.config.ts` adds it as an explicit `rollupOptions.input` — keep that wiring if you rename or move the file.

### Path aliases

`@/*` → `src/*`, `@shared/*` → `src/shared/*`, `@ext/*` → `src/extension/*`. Configured in both `tsconfig.json` and `vite.config.ts`/`vitest.config.ts` — keep all three in sync when adding aliases.

### Source layout pointers (non-obvious splits)

- `src/extension/content/` — content-script entry, Shadow-DOM bootstrap, FAB, and `domHandlers.ts` (the in-page handler for `dom_op_request` broadcasts).
- `src/extension/ui/` — presentational React components rendered inside the Shadow DOM: `ChatWindow`, `Composer`, `MessageList`, `MessageBubble`, `ToolCallCard`. No Chrome APIs here.
- `src/extension/options/` — options page (separate Vite entry).
- `src/extension/storage/` — IndexedDB store wrappers (`conversations`, `messages`, `skills`, `skillData`, `auditLog`) plus `chrome.storage` wrappers (`settings`, `rules`, `transient`); `db.ts` owns the versioned schema.

### Toggle-chat keyboard command

`manifest.json` declares a `toggle-chat` command (default `Ctrl/Cmd+Shift+K`). It's handled by `chrome.commands.onCommand` in `background.ts`, which forwards a toggle message to the active tab's content script — don't add a second binding for the same action.

### Tool & agent loop

`src/agent/query/QueryEngine.ts` runs an OpenAI-compatible chat loop with tool-calls, max-iterations cap, and an `AbortSignal` for cancel. Tool implementations live in `src/tools/` (one file per tool — currently `readPage`, `readSelection`, `querySelector`, `screenshot`, `listTabs`, `fetchGet`, plus `registry.ts`); they are imported and registered in `offscreen.ts` via `ToolRegistry`. Each tool is a `ToolDefinition` (`src/shared/types.ts`) that returns a discriminated `ToolResult<T> = { ok: true; data } | { ok: false; error }`. The engine never throws on tool failure — errors travel through the result envelope so the LLM sees them and can react. Preserve this contract when writing new tools.

LLM provider is **OpenAI-compatible only** (`{ apiKey, baseUrl, model }`) — explicitly out of scope: OAuth, Bedrock/Vertex/Foundry, MCP. Don't add adapters.

## Conventions worth knowing

- **All cross-process messages on the long-lived ports must satisfy the Zod schemas in `protocol.ts`.** When adding a new command/event, extend the discriminated union and add the corresponding handler — don't smuggle untyped fields through.
- **Plan-driven**: when starting a multi-step change, check `docs/superpowers/plans/` for an existing plan and either follow it or write a new one before coding.
- README and design docs include Chinese comments and prose throughout — match the surrounding language when editing those files; code comments are mostly English.
