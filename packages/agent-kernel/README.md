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
