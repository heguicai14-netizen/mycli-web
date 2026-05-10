# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This repo is a **Bun workspace** with two packages: a reusable agent kernel library and a reference Chrome MV3 extension that consumes it. The user chats with an OpenAI-compatible LLM via a Shadow-DOM floating window injected into any page; the agent has browser tools (DOM read/write, tabs, screenshots, fetch) and is being grown toward sub-agents and user-installable skills (some skill code runs in sandbox iframes). Project is plan-driven.

Design of record: `docs/superpowers/specs/2026-04-24-mycli-web-design.md` (original) and `docs/superpowers/specs/2026-05-10-agent-kernel-extraction-design.md` (current workspace layout). Phased plans in `docs/superpowers/plans/`.

## Workspace layout

Bun workspace with two packages:

- **`packages/agent-kernel/`** — the reusable agent kernel library. Platform-aware (browser-only) but extension-agnostic. Provides agent loop, RPC, skills, assembly helpers, adapters. Internal only (not published to npm).
- **`packages/mycli-web/`** — the reference Chrome extension consuming agent-kernel. Provides UI, settings UI, business tools, skill content.

Inside each package, `CLAUDE.md` (if present) gives package-specific guidance. Read both before editing across packages.

Build/test/typecheck commands run from the workspace root or per-package via `bun --cwd packages/<name> run <script>`.

## Commands

```bash
bun install                                         # workspace-wide install
bun run typecheck                                   # tsc -b across both packages
bun --cwd packages/agent-kernel run test            # kernel tests (vitest)
bun --cwd packages/mycli-web run test               # consumer tests (vitest)
bun --cwd packages/mycli-web run build              # vite + @crxjs → dist/
bun --cwd packages/mycli-web run dev                # vite dev (rare for extensions)
```

Run a single test file: `bun --cwd packages/mycli-web run test tests/rpc/hub.test.ts`. Run a single case: append `-t "name fragment"`.

Requires **bun ≥ 1.3.5** and **Node ≥ 24**. Each package's `tests/setup.ts` auto-installs `fake-indexeddb` and re-installs the chrome.* mock in `beforeEach` — tests don't need to do that themselves.

## Architecture

### Two packages, one direction of dependency

`packages/mycli-web` depends on `packages/agent-kernel` (declared as `"agent-kernel": "workspace:*"`). The kernel never depends on mycli-web. Most "what does the agent loop do" answers live in the kernel; most "what does this particular extension do" answers live in mycli-web.

For the full kernel API surface, see `packages/agent-kernel/README.md` and `packages/agent-kernel/docs/`.

### Four process boundaries (still apply, inside the consumer)

The extension is split across four contexts that **cannot share memory** and only talk via Chrome message-passing. Knowing which context a file belongs to is essential before editing it.

| Context | Lifetime | Responsibility | Never does |
|---|---|---|---|
| **Content script** (`packages/mycli-web/src/extension/content/`, one per tab) | Page load → navigation | Shadow-DOM React UI (chat window, FAB), DOM ops on its own page | Holds agent state, calls LLM, talks to skill sandboxes |
| **Service Worker** (`packages/mycli-web/src/extension/background.ts`, ≤1 instance, easily suspended) | Event-driven | Delegates to kernel's `installKernelBackground` (RPC routing, `chrome.*` proxy, offscreen-document lifecycle, keyboard command handler) | Runs the agent loop, holds long-lived state |
| **Offscreen document** (`packages/mycli-web/src/extension/offscreen.ts`, ≤1 instance, kept alive while needed) | Created on first activation by SW | Delegates to kernel's `bootKernelOffscreen` (`QueryEngine` agent loop, tool dispatch, IndexedDB I/O); hosts skill sandbox iframes | DOM mutations on user pages, UI rendering |
| **Sandbox iframe** (per code-skill, future) | Child of offscreen | Executes a skill's `tools.js` in a null-origin sandbox | Touches `chrome.*`, parent DOM, or extension storage |

A single conversation flows: user types in content script → port `session` → SW hub (kernel) → port `sw-to-offscreen` → offscreen QueryEngine (kernel) → LLM → tool dispatch → (back through the same chain).

### Two transports — don't confuse them

Both are implemented inside the kernel; consumer code rarely touches them directly.

1. **Long-lived ports** carry chat traffic: `RpcClient` (in content) opens `chrome.runtime.connect({ name: 'session' })`, the kernel's hub in SW (`installHub`) accepts it and opens its own port to the offscreen doc (`name: 'sw-to-offscreen'`). All such messages are validated against the Zod `ClientCmd` / `AgentEvent` schemas in `packages/agent-kernel/src/browser/rpc/protocol.ts`.
2. **One-shot `chrome.runtime.sendMessage` broadcasts** carry tool-execution side traffic: when the offscreen doc needs to do a DOM op or a `chrome.*` call, it broadcasts a `dom_op_request` / `chrome_api_request`, the SW (kernel's `domOpRouter`) handles it, then broadcasts a `*_result` message back. The kernel's `sendDomOp` / `callChromeApi` helpers correlate by a randomly generated `id`. This bypasses the port and is **not** Zod-validated — keep payload shapes consistent with the existing handlers.

When adding a new tool inside `packages/mycli-web/src/extension-tools/`, decide which transport it needs based on `ToolDefinition.exec`:
- `exec: 'content'` → tool calls `ctx.rpc.domOp(...)` (uses the broadcast transport, ends up in `domHandlers.ts` in the target tab)
- `exec: 'sw'` → tool calls `ctx.rpc.chromeApi(...)` (handled by kernel's `domOpRouter`; you'll need to add a case there if a new chrome.* method is needed)
- `exec: 'offscreen'` → tool runs purely inside offscreen, no RPC needed

### Storage split

Two storage layers, used for different things — don't conflate:

- **IndexedDB** — the kernel ships a default IDB-backed `MessageStoreAdapter` (`createIdbMessageStore`) that uses DB name `agent-kernel`. The consumer (`packages/mycli-web`) may also keep its own IDB for skills and audit log under a different DB name to avoid collisions.
- **`chrome.storage.local`** for Zod-validated settings (`packages/mycli-web/src/extension/storage/settings.ts`) and approval rules (`storage/rules.ts`). Settings are exposed to the kernel via `mycliSettingsAdapter` (the consumer's `SettingsAdapter` implementation).
- **`chrome.storage.session`** for transient UI state (`storage/transient.ts`). Note: the kernel's SW boot widens its access level to `TRUSTED_AND_UNTRUSTED_CONTEXTS` so content scripts can read it — don't undo that.

### Vite quirk: offscreen.html must be an explicit input

`packages/mycli-web/html/offscreen.html` is loaded via `chrome.offscreen.createDocument` rather than referenced from `manifest.json`, so `@crxjs/vite-plugin` won't discover it. `vite.config.ts` adds it as an explicit `rollupOptions.input` — keep that wiring if you rename or move the file.

### Path aliases

Inside `packages/mycli-web`: `@/*` → `src/*`, `@ext/*` → `src/extension/*`, `@ext-tools/*` → `src/extension-tools/*`, `@ext-skills/*` → `src/extension-skills/*`. Configured in `tsconfig.base.json`, `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts` — keep all four in sync when adding aliases.

The kernel package does **not** use path aliases; consumers always import from the bare specifier `agent-kernel`.

### Source layout pointers (non-obvious splits)

- `packages/mycli-web/src/extension/content/` — content-script entry, Shadow-DOM bootstrap, FAB.
- `packages/mycli-web/src/extension/ui/` — presentational React components rendered inside the Shadow DOM: `ChatWindow`, `Composer`, `MessageList`, `MessageBubble`, `ToolCallCard`. No Chrome APIs here.
- `packages/mycli-web/src/extension/options/` — options page (separate Vite entry).
- `packages/mycli-web/src/extension/storage/` — `chrome.storage` wrappers (`settings`, `rules`, `transient`); message/conversation persistence is handled by the kernel.
- `packages/mycli-web/src/extension/settingsAdapter.ts` — consumer's implementation of the kernel's `SettingsAdapter` interface.
- `packages/agent-kernel/src/core/` — agent loop, LLM client, tool/registry types.
- `packages/agent-kernel/src/browser/` — Chrome-MV3 plumbing (rpc/, agentClient, agentService, domOp router, assembly helpers).
- `packages/agent-kernel/src/skills/` — `SkillRegistry`, `parseSkillMd`, meta-tool factories, loaders.
- `packages/agent-kernel/src/adapters/` — `SettingsAdapter`, `MessageStoreAdapter`, `ToolContextBuilder` interfaces.

### Toggle-chat keyboard command

`packages/mycli-web/manifest.json` declares a `toggle-chat` command (default `Ctrl/Cmd+Shift+K`). The kernel's `installKernelBackground` registers the `chrome.commands.onCommand` listener and forwards a toggle message to the active tab's content script — don't add a second binding for the same action.

### Tool & agent loop

`packages/agent-kernel/src/core/QueryEngine.ts` runs an OpenAI-compatible chat loop with tool-calls, max-iterations cap, and an `AbortSignal` for cancel. Generic tool implementations live in `packages/agent-kernel/src/tools/` (currently only `fetchGet`); extension-specific ones (`readPage`, `readSelection`, `querySelector`, `screenshot`, `listTabs`) live in `packages/mycli-web/src/extension-tools/tools/` and are passed into `bootKernelOffscreen({ tools: [...] })`. Each tool is a `ToolDefinition` (`packages/agent-kernel/src/core/types.ts`) that returns a discriminated `ToolResult<T> = { ok: true; data } | { ok: false; error }`. The engine never throws on tool failure — errors travel through the result envelope so the LLM sees them and can react. Preserve this contract when writing new tools.

LLM provider is **OpenAI-compatible only** (`{ apiKey, baseUrl, model, fetchTimeoutMs }`) — explicitly out of scope: OAuth, Bedrock/Vertex/Foundry, MCP. Don't add adapters.

## Conventions worth knowing

- **All cross-process messages on the long-lived ports must satisfy the Zod schemas in the kernel's `protocol.ts`.** When adding a new command/event, extend the discriminated union and add the corresponding handler — don't smuggle untyped fields through.
- **Plan-driven**: when starting a multi-step change, check `docs/superpowers/plans/` for an existing plan and either follow it or write a new one before coding.
- **Cross-package edits**: kernel changes can break the consumer; consumer changes never need a kernel change unless a new public API is needed. After kernel changes, run typecheck + both packages' test suites + the consumer build.
- README and design docs include Chinese comments and prose throughout — match the surrounding language when editing those files; code comments are mostly English.
