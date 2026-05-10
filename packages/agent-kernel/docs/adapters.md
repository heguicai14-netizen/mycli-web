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
