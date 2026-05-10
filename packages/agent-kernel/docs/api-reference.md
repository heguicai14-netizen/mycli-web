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
