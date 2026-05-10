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
