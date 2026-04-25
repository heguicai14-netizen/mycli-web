# mycli-web Plan A — 脚手架 + 基础设施

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 mycli 复制成 mycli-web，剥离 CLI/TUI 专属代码，搭建 MV3 扩展构建链路（Vite + @crxjs + React + Tailwind），建立可测试的 RPC 协议层（content ↔ SW ↔ offscreen）与存储层（IndexedDB + chrome.storage），加载到 Chrome 后 FAB 可见、端到端 RPC 回声通过。

**Architecture:** 三层进程（Content Script / Service Worker / Offscreen Document）通过 `chrome.runtime.Port` 长连接通讯，SW 作为总线、offscreen 作为 agent 宿主（本 plan 仅占位）、content script 渲染 Shadow DOM 浮窗（本 plan 为占位 FAB）。数据存储分两层：`chrome.storage.local/session` 放小而频繁的配置，IndexedDB（通过 `idb` 封装）放对话、skill、审计日志。所有跨进程消息用 Zod 校验。

**Tech Stack:** TypeScript / React 18 / Vite / @crxjs/vite-plugin / Tailwind CSS / Zod / idb / vitest / @testing-library/react / fake-indexeddb / @types/chrome.

**Prerequisites:** 工作区 `/Users/heguicai/myProject/`。已有 `my-cli/` 和 `docs/superpowers/specs/2026-04-24-mycli-web-design.md`。系统有 bun ≥ 1.3.5、Node ≥ 24、Chrome 浏览器可用。

**关键设计决策（本 plan 做出并锁定）：**

1. Content script 在 manifest 中用 `content_scripts.matches: ["<all_urls>"]` 自动加载，但 FAB 默认渲染；用户可在 settings 关闭。精确的"仅激活 tab 才注入"形态留给后续优化。
2. Offscreen document 用 `reasons: ["IFRAME_SCRIPTING"]` 创建，为 Plan F 的 sandbox 准备。
3. IndexedDB 用 `idb` 库（Jake Archibald，行业标准）封装；schema 版本从 v1 起步。
4. RPC 端口名统一为 `"session"`；每条客户端命令带 UUID，offscreen 必回 ack 或 error。
5. 测试双栈：vitest（Node 环境，用 `fake-indexeddb` mock DB + 自写 `chrome.*` mock）跑纯单元/契约；Playwright 留给 Plan B 及以后做 E2E。
6. 仓库在本 plan 最后一步 `git init` 并做首个干净 commit；设计 spec 文档挪入 `mycli-web/docs/`。

**File Structure After Plan A:**

```
mycli-web/
├── .gitignore
├── README.md                                (从 mycli 继承并改写)
├── manifest.json
├── package.json
├── tsconfig.json
├── tsconfig.test.json
├── vite.config.ts
├── vitest.config.ts
├── tailwind.config.js
├── postcss.config.js
├── bun.lock                                 (由 bun install 生成)
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-04-24-mycli-web-design.md  (从上级目录移入)
├── html/
│   ├── offscreen.html
│   ├── options.html
│   └── sandbox.html
├── public/
│   └── icons/
│       ├── icon-16.png                       (占位)
│       ├── icon-48.png                       (占位)
│       └── icon-128.png                      (占位)
├── src/
│   ├── shared/
│   │   └── types.ts
│   ├── extension/
│   │   ├── background.ts
│   │   ├── offscreen.ts
│   │   ├── content/
│   │   │   ├── index.ts
│   │   │   └── fab.tsx
│   │   ├── options/
│   │   │   └── OptionsApp.tsx
│   │   ├── rpc/
│   │   │   ├── protocol.ts
│   │   │   ├── hub.ts
│   │   │   └── client.ts
│   │   └── storage/
│   │       ├── db.ts
│   │       ├── conversations.ts
│   │       ├── messages.ts
│   │       ├── skills.ts
│   │       ├── skillData.ts
│   │       ├── auditLog.ts
│   │       ├── settings.ts
│   │       ├── rules.ts
│   │       └── transient.ts
│   └── styles/
│       └── content.css
└── tests/
    ├── setup.ts
    ├── mocks/
    │   └── chrome.ts
    ├── protocol.test.ts
    ├── rpc/
    │   └── hub.test.ts
    └── storage/
        ├── db.test.ts
        ├── conversations.test.ts
        ├── messages.test.ts
        ├── skills.test.ts
        ├── skillData.test.ts
        ├── auditLog.test.ts
        ├── settings.test.ts
        └── rules.test.ts
```

---

## Section 1 — 复制并清理 mycli

### Task 1: 复制 mycli 为 mycli-web

**Files:** (filesystem ops, no source file edits)

- [ ] **Step 1: 切到父目录并复制**

Run:
```bash
cd /Users/heguicai/myProject
cp -R my-cli mycli-web
```
Expected: 无输出；`ls` 可见 `mycli-web/` 目录。

- [ ] **Step 2: 删除复制过来的 .git**

Run:
```bash
rm -rf mycli-web/.git mycli-web/.mycli mycli-web/.claude
```
Expected: 无输出。验证：
```bash
ls -la mycli-web/ | grep -E "^\.git|^\.mycli|^\.claude"
```
应该无输出（这些都被删了）。

- [ ] **Step 3: 验证复制完整**

Run:
```bash
ls mycli-web/src | head -20
```
Expected: 看到 `main.tsx`、`QueryEngine.ts` 等 mycli 源文件（下一步会删除）。

---

### Task 2: 删除 CLI / TUI / Node-only 代码路径

**Files:** 清理 mycli-web 内多个目录（这些路径规范由 spec §4 "从 mycli 副本中要删除的内容" 决定）

- [ ] **Step 1: 删除 CLI 入口与 TUI**

Run:
```bash
cd /Users/heguicai/myProject/mycli-web
rm -f src/main.tsx src/bootstrap-entry.ts src/dev-entry.ts src/bootstrapMacro.ts
rm -rf src/entrypoints src/components src/commands
rm -f src/ink.ts src/interactiveHelpers.tsx src/replLauncher.tsx src/dialogLaunchers.tsx
rm -f src/commands.ts src/history.ts src/setup.ts src/projectOnboardingState.ts
```
Expected: 无输出。

- [ ] **Step 2: 删除 MCP / remote / bridge / tasks / skills / tools 原版**

Run:
```bash
rm -rf src/services/mcp src/services/remoteManagedSettings src/remote src/bridge
rm -rf src/tasks src/skills src/tools
```

- [ ] **Step 3: 删除 native / shim / vendor / bin**

Run:
```bash
rm -rf src/native-ts shims vendor bin scripts
rm -f image-processor.node
```

- [ ] **Step 4: 删除订阅限流 / 非 OpenAI provider / TUI-only service**

Run:
```bash
rm -f src/services/voice.ts src/services/voiceKeyterms.ts src/services/voiceStreamSTT.ts
rm -f src/services/preventSleep.ts src/services/awaySummary.ts src/services/notifier.ts
rm -f src/services/mycliAiLimits.ts src/services/mycliAiLimitsHook.ts
rm -f src/services/rateLimitMessages.ts src/services/rateLimitMocking.ts src/services/mockRateLimits.ts
rm -f src/services/diagnosticTracking.ts src/services/internalLogging.ts src/services/vcr.ts
rm -f src/services/mcpServerApproval.tsx
```

- [ ] **Step 5: 删除 mycli 根级无用文件**

Run:
```bash
rm -f bun.lock bunfig.toml MYCLI.md AGENTS.md CLAUDE.md preview.png tsconfig.json
```
保留 `package.json`（Task 3 重写）、`README.md`（Task 3 结尾改写）。

- [ ] **Step 6: 清理剩余 src/services 内仅供 CLI 使用的子目录（保留 token/cost 评估等）**

列出残余：
```bash
ls src/services/
```
按 spec §4 删除不再需要的文件。对于本 plan 的目的，只保留下列最小集（需要在 Plan B 移植时参考的原始文件）：
```bash
# 先看看残余有什么
ls src/services/
```

保留：`api/openaiCompatibleClient.ts`（若存在）、`api/tokenEstimation.ts`（若存在）、`remoteManagedSettings/` 以下子项应已删除。其余 `src/services/*.ts` 一律删除：
```bash
find src/services -maxdepth 1 -type f -name "*.ts" ! -name "tokenEstimation.ts" -delete
# 如果有 skillSearch、remoteManagedSettings 残余目录也清
rm -rf src/services/skillSearch src/services/remoteManagedSettings
```
（openaiCompatibleClient.ts 在 `src/services/api/` 下，不受上面 find 影响。）

- [ ] **Step 7: 清 src 下残余 UI / moreright / jobs**

Run:
```bash
rm -rf src/moreright src/jobs
rm -f src/QueryEngine.ts src/query.ts src/Task.ts src/Tool.ts src/tools.ts src/tasks.ts
rm -f src/costHook.ts src/cost-tracker.ts src/context.ts src/globals.d.ts
rm -rf src/query
```
这些文件在 Plan B 会重新移植到 `src/agent/` 下；本 plan 直接清空 src/ 保持干净，Plan B 从 mycli 源码树重新提取。

- [ ] **Step 8: 确认 src 现在几乎为空**

Run:
```bash
find src -type f | head
```
Expected: 应为空（或仅剩极少量残留；若有，继续按需 rm）。

- [ ] **Step 9: Commit checkpoint（暂缓，git 要到 Task 50 才 init）**

跳过；本步是思维 placeholder，不执行任何命令。

---

## Section 2 — 包配置与 TypeScript 配置

### Task 3: 重写 package.json

**Files:**
- Modify: `mycli-web/package.json`

- [ ] **Step 1: 读现有 package.json**

Run:
```bash
cat mycli-web/package.json | head -20
```
确认是 mycli 原版。

- [ ] **Step 2: 用最小依赖集覆写**

Create (overwrite) `mycli-web/package.json`:
```json
{
  "name": "mycli-web",
  "version": "0.1.0",
  "private": true,
  "description": "Chrome MV3 browser-agent extension (mycli web port).",
  "type": "module",
  "engines": {
    "bun": ">=1.3.5",
    "node": ">=24.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zod": "^3.23.8",
    "idb": "^8.0.0"
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

- [ ] **Step 3: 安装依赖**

Run:
```bash
cd /Users/heguicai/myProject/mycli-web
bun install
```
Expected: `bun install` 成功，生成 `bun.lock` 和 `node_modules/`。若有 peer 警告可忽略，有 error 需解决后重试。

---

### Task 4: 写 tsconfig.json

**Files:**
- Create: `mycli-web/tsconfig.json`
- Create: `mycli-web/tsconfig.test.json`

- [ ] **Step 1: 主 tsconfig**

Create `mycli-web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "allowImportingTsExtensions": false,
    "types": ["chrome", "vite/client"],
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["./src/shared/*"],
      "@ext/*": ["./src/extension/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/**/*", "html/**/*", "manifest.json"]
}
```

- [ ] **Step 2: 测试专用 tsconfig**

Create `mycli-web/tsconfig.test.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["chrome", "vitest/globals", "node"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: 验证 typecheck 能跑（空 src 下）**

Run:
```bash
bun run typecheck
```
Expected: 不报错（src 几乎为空）。

---

### Task 5: 写 Vite 配置 + Tailwind 配置

**Files:**
- Create: `mycli-web/vite.config.ts`
- Create: `mycli-web/tailwind.config.js`
- Create: `mycli-web/postcss.config.js`
- Create: `mycli-web/src/styles/content.css`

- [ ] **Step 1: Vite 配置（CRX + React）**

Create `mycli-web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json' with { type: 'json' }
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@ext': path.resolve(__dirname, 'src/extension'),
    },
  },
  plugins: [
    react(),
    crx({ manifest }),
  ],
  build: {
    target: 'chrome114',
    minify: false, // Plan A 期间便于人工审 dist
    sourcemap: true,
    emptyOutDir: true,
  },
})
```

- [ ] **Step 2: Tailwind 配置（注意 content 路径覆盖 Shadow DOM 组件）**

Create `mycli-web/tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/**/*.{ts,tsx,html}',
    './html/**/*.html',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

- [ ] **Step 3: PostCSS 配置**

Create `mycli-web/postcss.config.js`:
```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **Step 4: 内容脚本样式 bundle（先建一个空样式文件占位，后面 FAB 会引用）**

Create `mycli-web/src/styles/content.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Shadow DOM 根节点重置，防止宿主页面样式渗透 */
:host {
  all: initial;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
}
```

---

### Task 6: 写 vitest 配置与测试 mock

**Files:**
- Create: `mycli-web/vitest.config.ts`
- Create: `mycli-web/tests/setup.ts`
- Create: `mycli-web/tests/mocks/chrome.ts`

- [ ] **Step 1: vitest 配置**

Create `mycli-web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@ext': path.resolve(__dirname, 'src/extension'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
```

- [ ] **Step 2: 测试 setup（装 fake-indexeddb + chrome mock）**

Create `mycli-web/tests/setup.ts`:
```ts
import 'fake-indexeddb/auto'
import { installChromeMock } from './mocks/chrome'
import { beforeEach } from 'vitest'

beforeEach(() => {
  installChromeMock()
})
```

- [ ] **Step 3: 写最小 chrome.runtime / chrome.storage mock**

Create `mycli-web/tests/mocks/chrome.ts`:
```ts
type Listener<T = any> = (...args: any[]) => T

interface PortEndpoint {
  name: string
  listeners: Set<Listener>
  disconnectListeners: Set<Listener>
  remote?: PortEndpoint
  disconnected: boolean
}

function createPortPair(name: string) {
  const a: PortEndpoint = { name, listeners: new Set(), disconnectListeners: new Set(), disconnected: false }
  const b: PortEndpoint = { name, listeners: new Set(), disconnectListeners: new Set(), disconnected: false }
  a.remote = b
  b.remote = a
  return [a, b] as const
}

function asPort(ep: PortEndpoint): chrome.runtime.Port {
  return {
    name: ep.name,
    onMessage: {
      addListener: (cb: Listener) => ep.listeners.add(cb),
      removeListener: (cb: Listener) => ep.listeners.delete(cb),
      hasListener: (cb: Listener) => ep.listeners.has(cb),
    } as any,
    onDisconnect: {
      addListener: (cb: Listener) => ep.disconnectListeners.add(cb),
      removeListener: (cb: Listener) => ep.disconnectListeners.delete(cb),
      hasListener: (cb: Listener) => ep.disconnectListeners.has(cb),
    } as any,
    postMessage: (msg: unknown) => {
      if (ep.disconnected || !ep.remote) return
      for (const cb of ep.remote.listeners) cb(msg, asPort(ep.remote))
    },
    disconnect: () => {
      ep.disconnected = true
      if (ep.remote) {
        ep.remote.disconnected = true
        for (const cb of ep.remote.disconnectListeners) cb(asPort(ep.remote))
      }
    },
    sender: {},
  } as any
}

export function installChromeMock() {
  const connectListeners = new Set<Listener>()
  const storageLocal = new Map<string, unknown>()
  const storageSession = new Map<string, unknown>()

  ;(globalThis as any).chrome = {
    runtime: {
      connect: ({ name }: { name: string }) => {
        const [clientEnd, serverEnd] = createPortPair(name)
        // Fire server-side 'connect' listeners asynchronously (microtask)
        queueMicrotask(() => {
          for (const cb of connectListeners) cb(asPort(serverEnd))
        })
        return asPort(clientEnd)
      },
      onConnect: {
        addListener: (cb: Listener) => connectListeners.add(cb),
        removeListener: (cb: Listener) => connectListeners.delete(cb),
        hasListener: (cb: Listener) => connectListeners.has(cb),
      },
      sendMessage: (_msg: unknown, cb?: Listener) => {
        cb?.()
      },
      onMessage: {
        addListener: () => {},
        removeListener: () => {},
      },
      lastError: undefined,
    },
    storage: {
      local: {
        get: async (keys?: string | string[] | Record<string, unknown>) => {
          if (keys === undefined) return Object.fromEntries(storageLocal)
          const keyArr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
          const out: Record<string, unknown> = {}
          for (const k of keyArr) if (storageLocal.has(k)) out[k] = storageLocal.get(k)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storageLocal.set(k, v)
        },
        remove: async (keys: string | string[]) => {
          const arr = typeof keys === 'string' ? [keys] : keys
          for (const k of arr) storageLocal.delete(k)
        },
        clear: async () => storageLocal.clear(),
      },
      session: {
        get: async (keys?: string | string[]) => {
          if (keys === undefined) return Object.fromEntries(storageSession)
          const arr = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const k of arr) if (storageSession.has(k)) out[k] = storageSession.get(k)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storageSession.set(k, v)
        },
        remove: async (keys: string | string[]) => {
          const arr = typeof keys === 'string' ? [keys] : keys
          for (const k of arr) storageSession.delete(k)
        },
        clear: async () => storageSession.clear(),
      },
    },
    tabs: {
      query: async () => [],
    },
    scripting: {
      executeScript: async () => [],
    },
  }
}
```

- [ ] **Step 4: 验证 vitest 能跑（空测试集）**

Run:
```bash
bun run test
```
Expected: `No test files found`（这是正常的，我们还没写任何测试）；返回码 0 或 1 都可接受，关键是不要报其它错误（比如 config 错）。实际上 vitest 默认"no tests found"会以 1 退出——这没关系，继续下一步。

---

## Section 3 — manifest 与 HTML 壳

### Task 7: 写 manifest.json

**Files:**
- Create: `mycli-web/manifest.json`

- [ ] **Step 1: 写 MV3 manifest**

Create `mycli-web/manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "mycli-web",
  "version": "0.1.0",
  "description": "Chrome browser-agent extension (mycli web port).",
  "action": {
    "default_title": "Toggle mycli-web chat"
  },
  "background": {
    "service_worker": "src/extension/background.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/extension/content/index.ts"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
  "options_page": "html/options.html",
  "permissions": [
    "storage",
    "tabs",
    "scripting",
    "activeTab",
    "offscreen",
    "bookmarks",
    "history",
    "downloads",
    "alarms"
  ],
  "host_permissions": ["<all_urls>"],
  "commands": {
    "toggle-chat": {
      "suggested_key": {
        "default": "Ctrl+Shift+K",
        "mac": "Command+Shift+K"
      },
      "description": "Toggle mycli-web chat window"
    }
  },
  "sandbox": {
    "pages": ["html/sandbox.html"]
  },
  "web_accessible_resources": [
    {
      "resources": ["html/sandbox.html"],
      "matches": ["<all_urls>"]
    }
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'",
    "sandbox": "sandbox allow-scripts allow-forms; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self'"
  },
  "icons": {
    "16": "public/icons/icon-16.png",
    "48": "public/icons/icon-48.png",
    "128": "public/icons/icon-128.png"
  }
}
```

- [ ] **Step 2: 生成占位图标**

Run:
```bash
cd /Users/heguicai/myProject/mycli-web
mkdir -p public/icons
# 用 ImageMagick 生成纯色占位（如果本机没装可以用 Node 生成 1x1 透明 PNG 复制放大）
for s in 16 48 128; do
  if command -v convert >/dev/null; then
    convert -size ${s}x${s} xc:#3b82f6 public/icons/icon-${s}.png
  else
    # fallback：下载一个 blank png 或 base64 内嵌写入
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90\x77\x53\xde\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01\xf6\x17\xf8\x6e\x00\x00\x00\x00IEND\xaeB`\x82' > public/icons/icon-${s}.png
  fi
done
ls public/icons/
```
Expected: 三个文件存在：`icon-16.png`、`icon-48.png`、`icon-128.png`。

---

### Task 8: 写 HTML 壳（offscreen / options / sandbox）

**Files:**
- Create: `mycli-web/html/offscreen.html`
- Create: `mycli-web/html/options.html`
- Create: `mycli-web/html/sandbox.html`

- [ ] **Step 1: offscreen.html**

Create `mycli-web/html/offscreen.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>mycli-web offscreen</title>
  </head>
  <body>
    <div id="offscreen-root"></div>
    <script type="module" src="/src/extension/offscreen.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: options.html**

Create `mycli-web/html/options.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>mycli-web — Options</title>
    <link rel="stylesheet" href="/src/styles/content.css" />
  </head>
  <body class="bg-slate-50 text-slate-900">
    <div id="options-root"></div>
    <script type="module" src="/src/extension/options/OptionsApp.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: sandbox.html（MV3 manifest sandbox page，Plan F 会扩充；Plan A 仅占位）**

Create `mycli-web/html/sandbox.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>mycli-web sandbox</title>
  </head>
  <body>
    <script>
      // Plan A placeholder — Plan F will populate sandbox runtime here.
      window.parent?.postMessage({ kind: 'sandbox/ready', version: 0 }, '*')
    </script>
  </body>
</html>
```

---

## Section 4 — 共享类型与 RPC 协议

### Task 9: 写 shared/types.ts

**Files:**
- Create: `mycli-web/src/shared/types.ts`

- [ ] **Step 1: 写基础类型**

Create `mycli-web/src/shared/types.ts`:
```ts
// 跨进程广泛复用的基础类型。Plan B 会往这里补 AssistantMessage、ToolCall 等 agent 专属类型。

export type Uuid = string

export type ConversationId = Uuid
export type MessageId = Uuid
export type ToolCallId = Uuid
export type ApprovalId = Uuid
export type SkillId = string // skill name@version 组合，非 uuid

export type Role = 'user' | 'assistant' | 'tool' | 'system-synth'

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean; details?: unknown } }
```

---

### Task 10: 写 RPC 协议 schema（Zod）

**Files:**
- Create: `mycli-web/src/extension/rpc/protocol.ts`

- [ ] **Step 1: 写失败测试（先写 test，再实现）**

Create `mycli-web/tests/protocol.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ClientCmd, AgentEvent, Envelope } from '@ext/rpc/protocol'

describe('ClientCmd schema', () => {
  it('accepts chat/send with valid payload', () => {
    const parsed = ClientCmd.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'chat/send',
      text: 'hello',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects chat/send missing text', () => {
    const parsed = ClientCmd.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'chat/send',
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts approval/reply with decision once', () => {
    const parsed = ClientCmd.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'approval/reply',
      approvalId: '33333333-3333-4333-8333-333333333333',
      decision: 'once',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('AgentEvent schema', () => {
  it('accepts message/streamChunk', () => {
    const parsed = AgentEvent.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ts: 1_700_000_000_000,
      kind: 'message/streamChunk',
      messageId: '44444444-4444-4444-8444-444444444444',
      delta: 'hello',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('Envelope', () => {
  it('wraps client → offscreen command', () => {
    const parsed = Envelope.safeParse({
      direction: 'client->offscreen',
      payload: {
        id: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        ts: 1_700_000_000_000,
        kind: 'chat/cancel',
      },
    })
    expect(parsed.success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- protocol
```
Expected: 因 `@ext/rpc/protocol` 还不存在而 FAIL（模块解析报错）。

- [ ] **Step 3: 实现 protocol.ts**

Create `mycli-web/src/extension/rpc/protocol.ts`:
```ts
import { z } from 'zod'

export const Uuid = z.string().uuid()

const Base = z.object({
  id: Uuid,
  sessionId: Uuid,
  ts: z.number().int().nonnegative(),
})

// ---------------- Client → Offscreen ----------------

const ChatSend = Base.extend({
  kind: z.literal('chat/send'),
  text: z.string().min(1),
  // attachments shape intentionally open — Plan B locks it down
  attachments: z.array(z.unknown()).optional(),
})

const ChatCancel = Base.extend({
  kind: z.literal('chat/cancel'),
})

const ChatNewConversation = Base.extend({
  kind: z.literal('chat/newConversation'),
  title: z.string().optional(),
})

const ChatLoadConversation = Base.extend({
  kind: z.literal('chat/loadConversation'),
  conversationId: Uuid,
})

const ChatResubscribe = Base.extend({
  kind: z.literal('chat/resubscribe'),
  conversationId: Uuid.optional(),
})

const ApprovalReply = Base.extend({
  kind: z.literal('approval/reply'),
  approvalId: Uuid,
  decision: z.enum(['once', 'session', 'always', 'deny']),
})

const SkillSetEnabled = Base.extend({
  kind: z.literal('skill/setEnabled'),
  skillId: z.string(),
  enabled: z.boolean(),
})

const SkillInstall = Base.extend({
  kind: z.literal('skill/install'),
  // Detailed SkillPackage schema is Plan E; Plan A uses a loose shape.
  package: z.unknown(),
})

const PingCmd = Base.extend({
  kind: z.literal('ping'),
})

export const ClientCmd = z.discriminatedUnion('kind', [
  ChatSend,
  ChatCancel,
  ChatNewConversation,
  ChatLoadConversation,
  ChatResubscribe,
  ApprovalReply,
  SkillSetEnabled,
  SkillInstall,
  PingCmd,
])
export type ClientCmd = z.infer<typeof ClientCmd>

// ---------------- Offscreen → Client ----------------

// Placeholder for Plan B; kept permissive so Plan A schema tests can round-trip.
const MessageLike = z.object({
  id: Uuid,
  role: z.enum(['user', 'assistant', 'tool', 'system-synth']),
  content: z.unknown(),
  createdAt: z.number(),
})

const MessageAppended = Base.extend({
  kind: z.literal('message/appended'),
  message: MessageLike,
})

const MessageStreamChunk = Base.extend({
  kind: z.literal('message/streamChunk'),
  messageId: Uuid,
  delta: z.string(),
})

const ToolStart = Base.extend({
  kind: z.literal('tool/start'),
  toolCall: z.object({
    id: Uuid,
    tool: z.string(),
    args: z.unknown(),
  }),
})

const ToolEnd = Base.extend({
  kind: z.literal('tool/end'),
  toolCallId: Uuid,
  result: z.object({
    ok: z.boolean(),
    // full ToolResult schema in Plan B
  }).passthrough(),
})

const SubAgentSpawned = Base.extend({
  kind: z.literal('subAgent/spawned'),
  parent: Uuid,
  child: Uuid,
  reason: z.string(),
})

const SubAgentUpdate = Base.extend({
  kind: z.literal('subAgent/update'),
  child: Uuid,
  message: MessageLike,
})

const ApprovalRequested = Base.extend({
  kind: z.literal('approval/requested'),
  approval: z.object({
    id: Uuid,
    tool: z.string(),
    argsSummary: z.string(),
    origin: z.string().optional(),
  }),
})

const StateSnapshot = Base.extend({
  kind: z.literal('state/snapshot'),
  conversation: z.object({
    id: Uuid,
    title: z.string(),
    messages: z.array(MessageLike),
  }),
})

const PingEvt = Base.extend({
  kind: z.literal('pong'),
})

const CommandAck = Base.extend({
  kind: z.literal('command/ack'),
  correlationId: Uuid,
  ok: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

const FatalError = Base.extend({
  kind: z.literal('fatalError'),
  code: z.string(),
  message: z.string(),
})

export const AgentEvent = z.discriminatedUnion('kind', [
  MessageAppended,
  MessageStreamChunk,
  ToolStart,
  ToolEnd,
  SubAgentSpawned,
  SubAgentUpdate,
  ApprovalRequested,
  StateSnapshot,
  PingEvt,
  CommandAck,
  FatalError,
])
export type AgentEvent = z.infer<typeof AgentEvent>

// ---------------- Offscreen ↔ Content (DOM ops) ----------------

const DomReadPage = Base.extend({
  kind: z.literal('dom/readPage'),
  tabId: z.number().int(),
  mode: z.enum(['text', 'markdown', 'html-simplified']),
})

const DomClick = Base.extend({
  kind: z.literal('dom/click'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string(), all: z.boolean().optional() }),
})

const DomType = Base.extend({
  kind: z.literal('dom/type'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string() }),
  value: z.string(),
})

const DomScreenshot = Base.extend({
  kind: z.literal('dom/screenshot'),
  tabId: z.number().int(),
})

export const DomOp = z.discriminatedUnion('kind', [
  DomReadPage,
  DomClick,
  DomType,
  DomScreenshot,
])
export type DomOp = z.infer<typeof DomOp>

// ---------------- Envelope（跨端口统一信封）----------------

export const Envelope = z.object({
  direction: z.enum([
    'client->offscreen',
    'offscreen->client',
    'offscreen->content',
    'content->offscreen',
  ]),
  payload: z.union([ClientCmd, AgentEvent, DomOp]),
})
export type Envelope = z.infer<typeof Envelope>
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- protocol
```
Expected: 全部 PASS（3+ tests）。

---

## Section 5 — 存储层：IndexedDB 基础

### Task 11: 写 IndexedDB 打开器与 schema v1

**Files:**
- Create: `mycli-web/src/extension/storage/db.ts`
- Create: `mycli-web/tests/storage/db.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/db.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, DB_NAME, DB_VERSION, resetDbForTests } from '@ext/storage/db'

describe('openDb', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('creates all required object stores on first open', async () => {
    const db = await openDb()
    const names = Array.from(db.objectStoreNames).sort()
    expect(names).toEqual(['auditLog', 'conversations', 'messages', 'skillData', 'skills'].sort())
    db.close()
  })

  it('returns a connection at DB_VERSION', async () => {
    const db = await openDb()
    expect(db.version).toBe(DB_VERSION)
    db.close()
  })

  it('is idempotent — reopening returns the same schema', async () => {
    const db1 = await openDb()
    db1.close()
    const db2 = await openDb()
    expect(Array.from(db2.objectStoreNames).sort()).toEqual(
      ['auditLog', 'conversations', 'messages', 'skillData', 'skills'].sort(),
    )
    db2.close()
  })

  it('DB_NAME is mycli-web', () => {
    expect(DB_NAME).toBe('mycli-web')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/db
```
Expected: FAIL（`@ext/storage/db` 不存在）。

- [ ] **Step 3: 实现 db.ts**

Create `mycli-web/src/extension/storage/db.ts`:
```ts
import { openDB, deleteDB, type IDBPDatabase, type DBSchema } from 'idb'
import type { ConversationId, MessageId, SkillId } from '@shared/types'

export const DB_NAME = 'mycli-web'
export const DB_VERSION = 1

export interface ConversationRow {
  id: ConversationId
  title: string
  createdAt: number
  updatedAt: number
  pinnedTabId?: number
  lastActiveTabUrl?: string
  compactionCount: number
}

export interface MessageRow {
  id: MessageId
  conversationId: ConversationId
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system-synth'
  content: unknown
  toolCalls?: unknown[]
  toolResults?: unknown[]
  createdAt: number
  compacted: boolean
  pending?: boolean
  subAgentId?: string
}

export interface SkillRow {
  id: SkillId
  name: string
  version: string
  manifest: unknown
  bodyMarkdown: string
  toolsCode?: string
  hashes: Record<string, string>
  source: { kind: 'bundled' | 'file' | 'url'; path?: string; url?: string }
  installedAt: number
  enabled: boolean
}

export interface SkillDataRow {
  skillId: SkillId
  key: string
  value: unknown
}

export interface AuditLogRow {
  id: string
  conversationId?: ConversationId
  ts: number
  tool: string
  argsSummary: string
  resultSummary: string
  approvalUsed?: string
  outcome: 'ok' | 'denied' | 'error'
}

export interface MycliWebSchema extends DBSchema {
  conversations: { key: ConversationId; value: ConversationRow }
  messages: {
    key: MessageId
    value: MessageRow
    indexes: { 'by-conversation': [ConversationId, number] }
  }
  skills: { key: SkillId; value: SkillRow }
  skillData: { key: [SkillId, string]; value: SkillDataRow }
  auditLog: {
    key: string
    value: AuditLogRow
    indexes: { 'by-conversation': ConversationId; 'by-time': number }
  }
}

let _db: IDBPDatabase<MycliWebSchema> | null = null

export async function openDb(): Promise<IDBPDatabase<MycliWebSchema>> {
  if (_db) return _db
  _db = await openDB<MycliWebSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('conversations', { keyPath: 'id' })
        const msgs = db.createObjectStore('messages', { keyPath: 'id' })
        msgs.createIndex('by-conversation', ['conversationId', 'seq'], { unique: false })
        db.createObjectStore('skills', { keyPath: 'id' })
        db.createObjectStore('skillData', { keyPath: ['skillId', 'key'] })
        const audit = db.createObjectStore('auditLog', { keyPath: 'id' })
        audit.createIndex('by-conversation', 'conversationId', { unique: false })
        audit.createIndex('by-time', 'ts', { unique: false })
      }
    },
  })
  return _db
}

export async function resetDbForTests(): Promise<void> {
  if (_db) {
    _db.close()
    _db = null
  }
  await deleteDB(DB_NAME)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/db
```
Expected: 4 tests PASS。

---

### Task 12: 写 conversations store API

**Files:**
- Create: `mycli-web/src/extension/storage/conversations.ts`
- Create: `mycli-web/tests/storage/conversations.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/conversations.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
} from '@ext/storage/conversations'

describe('conversations store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('creates, fetches, lists, updates, and deletes', async () => {
    const created = await createConversation({ title: 'first' })
    expect(created.id).toMatch(/[0-9a-f-]{36}/i)
    expect(created.title).toBe('first')
    expect(created.compactionCount).toBe(0)

    const fetched = await getConversation(created.id)
    expect(fetched?.title).toBe('first')

    await createConversation({ title: 'second' })
    const list = await listConversations()
    expect(list.length).toBe(2)
    expect(list.map((c) => c.title).sort()).toEqual(['first', 'second'])

    await updateConversation(created.id, { title: 'first (edited)' })
    const reloaded = await getConversation(created.id)
    expect(reloaded?.title).toBe('first (edited)')
    expect(reloaded!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    await deleteConversation(created.id)
    expect(await getConversation(created.id)).toBeUndefined()
  })

  it('sorts listConversations by updatedAt desc', async () => {
    const a = await createConversation({ title: 'a' })
    await new Promise((r) => setTimeout(r, 2))
    const b = await createConversation({ title: 'b' })
    await new Promise((r) => setTimeout(r, 2))
    await updateConversation(a.id, { title: 'a2' })
    const list = await listConversations()
    expect(list[0].id).toBe(a.id) // updated most recently
    expect(list[1].id).toBe(b.id)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/conversations
```
Expected: FAIL。

- [ ] **Step 3: 实现 conversations.ts**

Create `mycli-web/src/extension/storage/conversations.ts`:
```ts
import { openDb, type ConversationRow } from './db'
import type { ConversationId } from '@shared/types'

function newId(): ConversationId {
  return crypto.randomUUID()
}

export async function createConversation(input: {
  title: string
  pinnedTabId?: number
  lastActiveTabUrl?: string
}): Promise<ConversationRow> {
  const db = await openDb()
  const now = Date.now()
  const row: ConversationRow = {
    id: newId(),
    title: input.title,
    createdAt: now,
    updatedAt: now,
    pinnedTabId: input.pinnedTabId,
    lastActiveTabUrl: input.lastActiveTabUrl,
    compactionCount: 0,
  }
  await db.put('conversations', row)
  return row
}

export async function getConversation(id: ConversationId): Promise<ConversationRow | undefined> {
  const db = await openDb()
  return db.get('conversations', id)
}

export async function listConversations(): Promise<ConversationRow[]> {
  const db = await openDb()
  const all = await db.getAll('conversations')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function updateConversation(
  id: ConversationId,
  patch: Partial<Omit<ConversationRow, 'id' | 'createdAt'>>,
): Promise<void> {
  const db = await openDb()
  const current = await db.get('conversations', id)
  if (!current) throw new Error(`conversation ${id} not found`)
  const next: ConversationRow = { ...current, ...patch, updatedAt: Date.now() }
  await db.put('conversations', next)
}

export async function deleteConversation(id: ConversationId): Promise<void> {
  const db = await openDb()
  await db.delete('conversations', id)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/conversations
```
Expected: 2 tests PASS。

---

### Task 13: 写 messages store API（带 by-conversation 索引）

**Files:**
- Create: `mycli-web/src/extension/storage/messages.ts`
- Create: `mycli-web/tests/storage/messages.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/messages.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import { createConversation } from '@ext/storage/conversations'
import {
  appendMessage,
  listMessagesByConversation,
  markMessagesCompacted,
  updateMessage,
  deleteMessagesByConversation,
} from '@ext/storage/messages'

describe('messages store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('appends messages with monotonic seq within a conversation', async () => {
    const c = await createConversation({ title: 'a' })
    const m1 = await appendMessage({
      conversationId: c.id,
      role: 'user',
      content: 'hi',
    })
    const m2 = await appendMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'hello',
    })
    expect(m1.seq).toBe(0)
    expect(m2.seq).toBe(1)
  })

  it('lists messages in seq order', async () => {
    const c = await createConversation({ title: 'a' })
    await appendMessage({ conversationId: c.id, role: 'user', content: 'a' })
    await appendMessage({ conversationId: c.id, role: 'assistant', content: 'b' })
    await appendMessage({ conversationId: c.id, role: 'user', content: 'c' })
    const list = await listMessagesByConversation(c.id)
    expect(list.map((m) => m.content)).toEqual(['a', 'b', 'c'])
  })

  it('seq is per-conversation, not global', async () => {
    const c1 = await createConversation({ title: '1' })
    const c2 = await createConversation({ title: '2' })
    const m1 = await appendMessage({ conversationId: c1.id, role: 'user', content: 'x' })
    const m2 = await appendMessage({ conversationId: c2.id, role: 'user', content: 'y' })
    expect(m1.seq).toBe(0)
    expect(m2.seq).toBe(0)
  })

  it('markMessagesCompacted sets compacted flag', async () => {
    const c = await createConversation({ title: 'a' })
    const m1 = await appendMessage({ conversationId: c.id, role: 'user', content: 'a' })
    const m2 = await appendMessage({ conversationId: c.id, role: 'assistant', content: 'b' })
    await markMessagesCompacted([m1.id, m2.id])
    const list = await listMessagesByConversation(c.id)
    expect(list.every((m) => m.compacted)).toBe(true)
  })

  it('updateMessage patches fields except id/conversationId/seq', async () => {
    const c = await createConversation({ title: 'a' })
    const m = await appendMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'partial',
      pending: true,
    })
    await updateMessage(m.id, { content: 'final', pending: false })
    const list = await listMessagesByConversation(c.id)
    expect(list[0].content).toBe('final')
    expect(list[0].pending).toBe(false)
    expect(list[0].seq).toBe(m.seq)
  })

  it('deleteMessagesByConversation clears only target conversation', async () => {
    const c1 = await createConversation({ title: '1' })
    const c2 = await createConversation({ title: '2' })
    await appendMessage({ conversationId: c1.id, role: 'user', content: 'x' })
    await appendMessage({ conversationId: c2.id, role: 'user', content: 'y' })
    await deleteMessagesByConversation(c1.id)
    expect((await listMessagesByConversation(c1.id)).length).toBe(0)
    expect((await listMessagesByConversation(c2.id)).length).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/messages
```
Expected: FAIL。

- [ ] **Step 3: 实现 messages.ts**

Create `mycli-web/src/extension/storage/messages.ts`:
```ts
import { openDb, type MessageRow } from './db'
import type { ConversationId, MessageId, Role } from '@shared/types'

function newId(): MessageId {
  return crypto.randomUUID()
}

export async function appendMessage(input: {
  conversationId: ConversationId
  role: Role
  content: unknown
  toolCalls?: unknown[]
  toolResults?: unknown[]
  pending?: boolean
  subAgentId?: string
}): Promise<MessageRow> {
  const db = await openDb()
  const tx = db.transaction(['messages', 'conversations'], 'readwrite')
  const idx = tx.objectStore('messages').index('by-conversation')
  // Find current max seq for this conversation.
  const range = IDBKeyRange.bound(
    [input.conversationId, 0],
    [input.conversationId, Number.MAX_SAFE_INTEGER],
  )
  let maxSeq = -1
  let cursor = await idx.openCursor(range, 'prev')
  if (cursor) {
    maxSeq = cursor.value.seq
  }
  const row: MessageRow = {
    id: newId(),
    conversationId: input.conversationId,
    seq: maxSeq + 1,
    role: input.role,
    content: input.content,
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    createdAt: Date.now(),
    compacted: false,
    pending: input.pending,
    subAgentId: input.subAgentId,
  }
  await tx.objectStore('messages').put(row)
  // Touch conversation.updatedAt
  const convStore = tx.objectStore('conversations')
  const conv = await convStore.get(input.conversationId)
  if (conv) {
    await convStore.put({ ...conv, updatedAt: Date.now() })
  }
  await tx.done
  return row
}

export async function listMessagesByConversation(
  conversationId: ConversationId,
): Promise<MessageRow[]> {
  const db = await openDb()
  const idx = db.transaction('messages').store.index('by-conversation')
  const range = IDBKeyRange.bound(
    [conversationId, 0],
    [conversationId, Number.MAX_SAFE_INTEGER],
  )
  const all = await idx.getAll(range)
  return all // already ordered by [conversationId, seq]
}

export async function updateMessage(
  id: MessageId,
  patch: Partial<Omit<MessageRow, 'id' | 'conversationId' | 'seq' | 'createdAt'>>,
): Promise<void> {
  const db = await openDb()
  const current = await db.get('messages', id)
  if (!current) throw new Error(`message ${id} not found`)
  await db.put('messages', { ...current, ...patch })
}

export async function markMessagesCompacted(ids: MessageId[]): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('messages', 'readwrite')
  for (const id of ids) {
    const cur = await tx.store.get(id)
    if (cur) await tx.store.put({ ...cur, compacted: true })
  }
  await tx.done
}

export async function deleteMessagesByConversation(
  conversationId: ConversationId,
): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('messages', 'readwrite')
  const idx = tx.store.index('by-conversation')
  const range = IDBKeyRange.bound(
    [conversationId, 0],
    [conversationId, Number.MAX_SAFE_INTEGER],
  )
  let cursor = await idx.openCursor(range)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/messages
```
Expected: 6 tests PASS。

---

### Task 14: 写 skills store API

**Files:**
- Create: `mycli-web/src/extension/storage/skills.ts`
- Create: `mycli-web/tests/storage/skills.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/skills.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import {
  putSkill,
  getSkill,
  listSkills,
  setSkillEnabled,
  deleteSkill,
} from '@ext/storage/skills'
import type { SkillRow } from '@ext/storage/db'

function makeSkill(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: 'sample@1.0.0',
    name: 'sample',
    version: '1.0.0',
    manifest: {},
    bodyMarkdown: '# sample',
    hashes: {},
    source: { kind: 'file' },
    installedAt: Date.now(),
    enabled: true,
    ...overrides,
  }
}

describe('skills store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('puts and fetches', async () => {
    const s = makeSkill()
    await putSkill(s)
    expect(await getSkill(s.id)).toEqual(s)
  })

  it('lists skills sorted by installedAt desc', async () => {
    await putSkill(makeSkill({ id: 'a@1', name: 'a', installedAt: 100 }))
    await putSkill(makeSkill({ id: 'b@1', name: 'b', installedAt: 200 }))
    const list = await listSkills()
    expect(list.map((s) => s.id)).toEqual(['b@1', 'a@1'])
  })

  it('setSkillEnabled toggles', async () => {
    await putSkill(makeSkill({ enabled: false }))
    await setSkillEnabled('sample@1.0.0', true)
    expect((await getSkill('sample@1.0.0'))!.enabled).toBe(true)
  })

  it('deleteSkill removes', async () => {
    await putSkill(makeSkill())
    await deleteSkill('sample@1.0.0')
    expect(await getSkill('sample@1.0.0')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/skills
```
Expected: FAIL。

- [ ] **Step 3: 实现 skills.ts**

Create `mycli-web/src/extension/storage/skills.ts`:
```ts
import { openDb, type SkillRow } from './db'
import type { SkillId } from '@shared/types'

export async function putSkill(row: SkillRow): Promise<void> {
  const db = await openDb()
  await db.put('skills', row)
}

export async function getSkill(id: SkillId): Promise<SkillRow | undefined> {
  const db = await openDb()
  return db.get('skills', id)
}

export async function listSkills(): Promise<SkillRow[]> {
  const db = await openDb()
  const all = await db.getAll('skills')
  return all.sort((a, b) => b.installedAt - a.installedAt)
}

export async function setSkillEnabled(id: SkillId, enabled: boolean): Promise<void> {
  const db = await openDb()
  const cur = await db.get('skills', id)
  if (!cur) throw new Error(`skill ${id} not found`)
  await db.put('skills', { ...cur, enabled })
}

export async function deleteSkill(id: SkillId): Promise<void> {
  const db = await openDb()
  await db.delete('skills', id)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/skills
```
Expected: 4 tests PASS。

---

### Task 15: 写 skillData store API

**Files:**
- Create: `mycli-web/src/extension/storage/skillData.ts`
- Create: `mycli-web/tests/storage/skillData.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/skillData.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import {
  setSkillValue,
  getSkillValue,
  listSkillValues,
  clearSkillValues,
} from '@ext/storage/skillData'

describe('skillData store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('set then get returns same value', async () => {
    await setSkillValue('skillA', 'k', { n: 1 })
    expect(await getSkillValue('skillA', 'k')).toEqual({ n: 1 })
  })

  it('isolates values per skillId', async () => {
    await setSkillValue('skillA', 'k', 'a')
    await setSkillValue('skillB', 'k', 'b')
    expect(await getSkillValue('skillA', 'k')).toBe('a')
    expect(await getSkillValue('skillB', 'k')).toBe('b')
  })

  it('listSkillValues returns only values for that skill', async () => {
    await setSkillValue('skillA', 'k1', 'v1')
    await setSkillValue('skillA', 'k2', 'v2')
    await setSkillValue('skillB', 'k1', 'other')
    const rows = await listSkillValues('skillA')
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.key).sort()).toEqual(['k1', 'k2'])
  })

  it('clearSkillValues wipes a skills bucket', async () => {
    await setSkillValue('skillA', 'k1', 'v1')
    await setSkillValue('skillB', 'k1', 'keep')
    await clearSkillValues('skillA')
    expect((await listSkillValues('skillA')).length).toBe(0)
    expect((await listSkillValues('skillB')).length).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/skillData
```
Expected: FAIL。

- [ ] **Step 3: 实现 skillData.ts**

Create `mycli-web/src/extension/storage/skillData.ts`:
```ts
import { openDb, type SkillDataRow } from './db'
import type { SkillId } from '@shared/types'

export async function setSkillValue(skillId: SkillId, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  await db.put('skillData', { skillId, key, value })
}

export async function getSkillValue(skillId: SkillId, key: string): Promise<unknown | undefined> {
  const db = await openDb()
  const row = await db.get('skillData', [skillId, key])
  return row?.value
}

export async function listSkillValues(skillId: SkillId): Promise<SkillDataRow[]> {
  const db = await openDb()
  const range = IDBKeyRange.bound([skillId, ''], [skillId, '￿'])
  return db.getAll('skillData', range)
}

export async function clearSkillValues(skillId: SkillId): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('skillData', 'readwrite')
  const range = IDBKeyRange.bound([skillId, ''], [skillId, '￿'])
  let cursor = await tx.store.openCursor(range)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/skillData
```
Expected: 4 tests PASS。

---

### Task 16: 写 auditLog store API（带 by-time 索引）

**Files:**
- Create: `mycli-web/src/extension/storage/auditLog.ts`
- Create: `mycli-web/tests/storage/auditLog.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/auditLog.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetDbForTests } from '@ext/storage/db'
import {
  appendAudit,
  listAuditByConversation,
  listAuditByTimeRange,
  pruneAuditOlderThan,
} from '@ext/storage/auditLog'

describe('auditLog store', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('appendAudit stores entry with auto id', async () => {
    const row = await appendAudit({
      conversationId: 'c1',
      tool: 'readPage',
      argsSummary: '{}',
      resultSummary: 'ok',
      outcome: 'ok',
    })
    expect(row.id).toMatch(/[0-9a-f-]{36}/i)
    expect(row.ts).toBeGreaterThan(0)
  })

  it('listAuditByConversation filters by conversation', async () => {
    await appendAudit({ conversationId: 'c1', tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await appendAudit({ conversationId: 'c2', tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    expect((await listAuditByConversation('c1')).length).toBe(1)
    expect((await listAuditByConversation('c2')).length).toBe(1)
  })

  it('listAuditByTimeRange filters by ts', async () => {
    const a = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await new Promise((r) => setTimeout(r, 2))
    const b = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    const range = await listAuditByTimeRange(a.ts, b.ts)
    expect(range.length).toBe(2)
  })

  it('pruneAuditOlderThan removes rows with ts < cutoff', async () => {
    const old = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await new Promise((r) => setTimeout(r, 5))
    const cutoff = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    const fresh = await appendAudit({ tool: 't', argsSummary: '', resultSummary: '', outcome: 'ok' })
    await pruneAuditOlderThan(cutoff)
    const all = await listAuditByTimeRange(0, Date.now() + 1000)
    expect(all.map((r) => r.id)).toEqual([fresh.id])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/auditLog
```
Expected: FAIL。

- [ ] **Step 3: 实现 auditLog.ts**

Create `mycli-web/src/extension/storage/auditLog.ts`:
```ts
import { openDb, type AuditLogRow } from './db'
import type { ConversationId } from '@shared/types'

export async function appendAudit(input: {
  conversationId?: ConversationId
  tool: string
  argsSummary: string
  resultSummary: string
  approvalUsed?: string
  outcome: AuditLogRow['outcome']
}): Promise<AuditLogRow> {
  const db = await openDb()
  const row: AuditLogRow = {
    id: crypto.randomUUID(),
    conversationId: input.conversationId,
    ts: Date.now(),
    tool: input.tool,
    argsSummary: input.argsSummary,
    resultSummary: input.resultSummary,
    approvalUsed: input.approvalUsed,
    outcome: input.outcome,
  }
  await db.put('auditLog', row)
  return row
}

export async function listAuditByConversation(
  conversationId: ConversationId,
): Promise<AuditLogRow[]> {
  const db = await openDb()
  return db.getAllFromIndex('auditLog', 'by-conversation', conversationId)
}

export async function listAuditByTimeRange(from: number, to: number): Promise<AuditLogRow[]> {
  const db = await openDb()
  const range = IDBKeyRange.bound(from, to)
  return db.getAllFromIndex('auditLog', 'by-time', range)
}

export async function pruneAuditOlderThan(cutoffTs: number): Promise<number> {
  const db = await openDb()
  const tx = db.transaction('auditLog', 'readwrite')
  const idx = tx.store.index('by-time')
  const range = IDBKeyRange.upperBound(cutoffTs, true)
  let cursor = await idx.openCursor(range)
  let removed = 0
  while (cursor) {
    await cursor.delete()
    removed++
    cursor = await cursor.continue()
  }
  await tx.done
  return removed
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/auditLog
```
Expected: 4 tests PASS。

---

## Section 6 — 存储层：chrome.storage

### Task 17: 写 settings（chrome.storage.local）

**Files:**
- Create: `mycli-web/src/extension/storage/settings.ts`
- Create: `mycli-web/tests/storage/settings.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/settings.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  patchSettings,
} from '@ext/storage/settings'

describe('settings', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear()
  })

  it('loadSettings returns defaults when empty', async () => {
    const s = await loadSettings()
    expect(s).toEqual(DEFAULT_SETTINGS)
  })

  it('saveSettings then loadSettings round-trips', async () => {
    const patched = { ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'gpt-4o' }
    await saveSettings(patched)
    const loaded = await loadSettings()
    expect(loaded.apiKey).toBe('sk-test')
    expect(loaded.model).toBe('gpt-4o')
  })

  it('patchSettings merges only provided keys', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'k1' })
    await patchSettings({ model: 'gpt-5' })
    const loaded = await loadSettings()
    expect(loaded.apiKey).toBe('k1')
    expect(loaded.model).toBe('gpt-5')
  })

  it('unknown stored fields are dropped on load (schema guard)', async () => {
    await chrome.storage.local.set({ mycliWebSettings: { ...DEFAULT_SETTINGS, bogus: 123 } as any })
    const loaded = await loadSettings()
    expect((loaded as any).bogus).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/settings
```
Expected: FAIL。

- [ ] **Step 3: 实现 settings.ts**

Create `mycli-web/src/extension/storage/settings.ts`:
```ts
import { z } from 'zod'

export const Settings = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().url().or(z.literal('')).default('https://api.openai.com/v1'),
  model: z.string().default('gpt-4o-mini'),
  systemPromptAddendum: z.string().default(''),
  subAgentMaxDepth: z.number().int().min(0).max(10).default(3),
  toolMaxIterations: z.number().int().min(1).max(500).default(50),
  fab: z
    .object({
      enabled: z.boolean().default(true),
      position: z.enum(['bottom-right', 'bottom-left']).default('bottom-right'),
    })
    .default({ enabled: true, position: 'bottom-right' }),
  shortcut: z.string().default('Ctrl+Shift+K'),
  skillHostStrictMode: z.boolean().default(true),
  injectScriptEnabled: z.boolean().default(false),
  auditLogRetentionDays: z.number().int().min(1).max(365).default(30),
  bundledSkillsEnabled: z.array(z.string()).default([]),
  contextAutoInject: z.enum(['none', 'url-title', 'url-title-and-selection']).default('url-title'),
})
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = Settings.parse({})

const KEY = 'mycliWebSettings'

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(KEY)
  const raw = r[KEY]
  if (raw === undefined) return DEFAULT_SETTINGS
  const parsed = Settings.safeParse(raw)
  if (!parsed.success) return DEFAULT_SETTINGS
  return parsed.data
}

export async function saveSettings(s: Settings): Promise<void> {
  const parsed = Settings.parse(s)
  await chrome.storage.local.set({ [KEY]: parsed })
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next: Settings = Settings.parse({ ...current, ...patch })
  await chrome.storage.local.set({ [KEY]: next })
  return next
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/settings
```
Expected: 4 tests PASS。

---

### Task 18: 写 approval rules（chrome.storage.local）

**Files:**
- Create: `mycli-web/src/extension/storage/rules.ts`
- Create: `mycli-web/tests/storage/rules.test.ts`

- [ ] **Step 1: 写失败测试**

Create `mycli-web/tests/storage/rules.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  addRule,
  listRules,
  removeRule,
  findMatchingRule,
} from '@ext/storage/rules'

describe('approval rules', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear()
  })

  it('addRule persists and listRules returns it', async () => {
    const r = await addRule({
      tool: 'click',
      scope: { kind: 'origin', origin: 'https://github.com' },
      decision: 'allow',
    })
    const list = await listRules()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(r.id)
  })

  it('removeRule deletes by id', async () => {
    const r = await addRule({ tool: 'click', scope: { kind: 'global' }, decision: 'allow' })
    await removeRule(r.id)
    expect((await listRules()).length).toBe(0)
  })

  it('expired rules are skipped by findMatchingRule', async () => {
    await addRule({
      tool: 'click',
      scope: { kind: 'global' },
      decision: 'allow',
      expiresAt: Date.now() - 1000,
    })
    const match = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.x' })
    expect(match).toBeUndefined()
  })

  it('findMatchingRule picks most specific match (originAndSelector > origin > global)', async () => {
    await addRule({ tool: 'click', scope: { kind: 'global' }, decision: 'allow' })
    await addRule({
      tool: 'click',
      scope: { kind: 'origin', origin: 'https://a.com' },
      decision: 'deny',
    })
    await addRule({
      tool: 'click',
      scope: { kind: 'originAndSelector', origin: 'https://a.com', selectorPattern: '.buy' },
      decision: 'allow',
    })
    const m = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.buy' })
    expect(m?.decision).toBe('allow')
    expect(m?.scope.kind).toBe('originAndSelector')

    const m2 = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.other' })
    expect(m2?.scope.kind).toBe('origin')
    expect(m2?.decision).toBe('deny')

    const m3 = await findMatchingRule({ tool: 'click', origin: 'https://b.com', selector: '.buy' })
    expect(m3?.scope.kind).toBe('global')
    expect(m3?.decision).toBe('allow')
  })

  it('rule tied to a different tool does not match', async () => {
    await addRule({ tool: 'type', scope: { kind: 'global' }, decision: 'allow' })
    const m = await findMatchingRule({ tool: 'click', origin: 'https://a.com', selector: '.x' })
    expect(m).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- storage/rules
```
Expected: FAIL。

- [ ] **Step 3: 实现 rules.ts**

Create `mycli-web/src/extension/storage/rules.ts`:
```ts
import { z } from 'zod'

export const ApprovalRule = z.object({
  id: z.string().uuid(),
  tool: z.string(),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('global') }),
    z.object({ kind: z.literal('origin'), origin: z.string() }),
    z.object({
      kind: z.literal('originAndSelector'),
      origin: z.string(),
      selectorPattern: z.string(),
    }),
    z.object({ kind: z.literal('urlPattern'), pattern: z.string() }),
  ]),
  decision: z.enum(['allow', 'deny']),
  expiresAt: z.number().optional(),
  createdAt: z.number(),
})
export type ApprovalRule = z.infer<typeof ApprovalRule>

const KEY = 'mycliWebRules'

async function readRules(): Promise<ApprovalRule[]> {
  const r = await chrome.storage.local.get(KEY)
  const raw = r[KEY]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x) => {
    const p = ApprovalRule.safeParse(x)
    return p.success ? [p.data] : []
  })
}

async function writeRules(rules: ApprovalRule[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: rules })
}

export async function listRules(): Promise<ApprovalRule[]> {
  return readRules()
}

export async function addRule(input: {
  tool: string
  scope: ApprovalRule['scope']
  decision: ApprovalRule['decision']
  expiresAt?: number
}): Promise<ApprovalRule> {
  const rules = await readRules()
  const row: ApprovalRule = {
    id: crypto.randomUUID(),
    tool: input.tool,
    scope: input.scope,
    decision: input.decision,
    expiresAt: input.expiresAt,
    createdAt: Date.now(),
  }
  rules.push(row)
  await writeRules(rules)
  return row
}

export async function removeRule(id: string): Promise<void> {
  const rules = await readRules()
  await writeRules(rules.filter((r) => r.id !== id))
}

function specificity(scope: ApprovalRule['scope']): number {
  switch (scope.kind) {
    case 'originAndSelector':
      return 3
    case 'origin':
      return 2
    case 'urlPattern':
      return 1
    case 'global':
      return 0
  }
}

function matchesScope(
  scope: ApprovalRule['scope'],
  query: { origin?: string; selector?: string; url?: string },
): boolean {
  switch (scope.kind) {
    case 'global':
      return true
    case 'origin':
      return query.origin === scope.origin
    case 'originAndSelector': {
      if (query.origin !== scope.origin) return false
      if (!query.selector) return false
      // Plan A: simple equality match; Plan C can upgrade to glob.
      return query.selector === scope.selectorPattern || new RegExp(scope.selectorPattern).test(query.selector)
    }
    case 'urlPattern':
      if (!query.url) return false
      return new RegExp(scope.pattern).test(query.url)
  }
}

export async function findMatchingRule(query: {
  tool: string
  origin?: string
  selector?: string
  url?: string
}): Promise<ApprovalRule | undefined> {
  const now = Date.now()
  const candidates = (await readRules())
    .filter((r) => r.tool === query.tool)
    .filter((r) => r.expiresAt === undefined || r.expiresAt > now)
    .filter((r) => matchesScope(r.scope, query))
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => specificity(b.scope) - specificity(a.scope))
  return candidates[0]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
bun run test -- storage/rules
```
Expected: 5 tests PASS。

---

### Task 19: 写 transient UI state（chrome.storage.session）

**Files:**
- Create: `mycli-web/src/extension/storage/transient.ts`

- [ ] **Step 1: 写 transient API（不用 TDD，因为 chrome.storage.session 已被 chrome mock 覆盖，且逻辑极薄）**

Create `mycli-web/src/extension/storage/transient.ts`:
```ts
import { z } from 'zod'

export const TransientUiState = z.object({
  activeConversationId: z.string().uuid().optional(),
  panelOpen: z.boolean().default(false),
  scrollTop: z.number().int().default(0),
  // Per-tab activation (keyed by tabId stringified)
  activatedTabs: z.record(z.string(), z.boolean()).default({}),
})
export type TransientUiState = z.infer<typeof TransientUiState>

const KEY = 'mycliWebUi'

export async function getTransientUi(): Promise<TransientUiState> {
  const r = await chrome.storage.session.get(KEY)
  const parsed = TransientUiState.safeParse(r[KEY])
  return parsed.success ? parsed.data : TransientUiState.parse({})
}

export async function setTransientUi(patch: Partial<TransientUiState>): Promise<TransientUiState> {
  const current = await getTransientUi()
  const next: TransientUiState = TransientUiState.parse({ ...current, ...patch })
  await chrome.storage.session.set({ [KEY]: next })
  return next
}
```

- [ ] **Step 2: 快速单测（一条 smoke）**

Create `mycli-web/tests/storage/transient.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getTransientUi, setTransientUi } from '@ext/storage/transient'

describe('transient ui state', () => {
  beforeEach(async () => {
    await chrome.storage.session.clear()
  })

  it('returns defaults when empty', async () => {
    const s = await getTransientUi()
    expect(s.panelOpen).toBe(false)
    expect(s.scrollTop).toBe(0)
  })

  it('patch then read round-trips', async () => {
    await setTransientUi({ panelOpen: true })
    expect((await getTransientUi()).panelOpen).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试**

Run:
```bash
bun run test -- storage/transient
```
Expected: 2 tests PASS。

---

## Section 7 — RPC 层

### Task 20: 写 RPC hub（SW 侧路由）与 client（两端通用）

**Files:**
- Create: `mycli-web/src/extension/rpc/hub.ts`
- Create: `mycli-web/src/extension/rpc/client.ts`
- Create: `mycli-web/tests/rpc/hub.test.ts`

- [ ] **Step 1: 写失败测试（跨进程 round-trip）**

Create `mycli-web/tests/rpc/hub.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { installHub } from '@ext/rpc/hub'
import { RpcClient } from '@ext/rpc/client'

/**
 * 测试拓扑：本测试只模拟 content ↔ SW 一段，SW 侧 hub 把收到的消息回显（echo）成 AgentEvent。
 * 真实实现里，SW 会把 payload 转发给 offscreen 的 port，并把 offscreen 的事件转回 client。
 * Plan A 的 hub 先实现"连接注册 + echo"形态；Plan B 以后把转发目标改为 offscreen port。
 */
describe('RPC hub (content ↔ SW)', () => {
  beforeEach(() => {
    // 重新安装干净的 chrome mock — tests/setup.ts 的 beforeEach 已处理
  })

  it('round-trips ping → pong with command/ack', async () => {
    installHub({ mode: 'echo' })
    const client = new RpcClient({ portName: 'session' })
    await client.connect()
    const ack = await client.send({
      kind: 'ping',
    })
    expect(ack.ok).toBe(true)

    const pong = await new Promise<any>((resolve) => {
      client.on('pong', resolve)
    })
    expect(pong.kind).toBe('pong')
    client.disconnect()
  })

  it('validates incoming client command against schema', async () => {
    installHub({ mode: 'echo' })
    const client = new RpcClient({ portName: 'session' })
    await client.connect()
    // 故意发一条非法 command（缺 text）
    const bad = client.sendRaw({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      ts: Date.now(),
      kind: 'chat/send',
      // text missing
    } as any)
    const ack = await bad
    expect(ack.ok).toBe(false)
    expect(ack.error?.code).toBe('schema_invalid')
    client.disconnect()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
bun run test -- rpc/hub
```
Expected: FAIL。

- [ ] **Step 3: 实现 hub.ts**

Create `mycli-web/src/extension/rpc/hub.ts`:
```ts
import { ClientCmd, AgentEvent } from './protocol'

export interface HubOptions {
  mode: 'echo' | 'offscreen-forward'
}

/**
 * SW 端路由。Plan A 仅实现 'echo' 模式（把 ping 回成 pong + ack 所有命令），
 * Plan B 会实现 'offscreen-forward' — 把 ClientCmd 转发到 offscreen port，反之亦然。
 */
export function installHub(options: HubOptions = { mode: 'echo' }) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'session') return
    port.onMessage.addListener((raw) => {
      const parsed = ClientCmd.safeParse(raw)
      if (!parsed.success) {
        port.postMessage(ackError(raw?.id, 'schema_invalid', parsed.error.message))
        return
      }
      const cmd = parsed.data
      // Ack everything.
      port.postMessage(ack(cmd.id, cmd.sessionId))
      // In echo mode, respond to ping with pong event.
      if (options.mode === 'echo' && cmd.kind === 'ping') {
        const pong: AgentEvent = {
          id: crypto.randomUUID(),
          sessionId: cmd.sessionId,
          ts: Date.now(),
          kind: 'pong',
        }
        port.postMessage(pong)
      }
      // In offscreen-forward mode, Plan B will replace with: forward to offscreen port.
    })
  })
}

function ack(correlationId: string, sessionId: string): AgentEvent {
  return {
    id: crypto.randomUUID(),
    sessionId,
    ts: Date.now(),
    kind: 'command/ack',
    correlationId,
    ok: true,
  }
}

function ackError(correlationId: string | undefined, code: string, message: string): AgentEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: '00000000-0000-4000-8000-000000000000',
    ts: Date.now(),
    kind: 'command/ack',
    correlationId: correlationId ?? '00000000-0000-4000-8000-000000000000',
    ok: false,
    error: { code, message },
  }
}
```

- [ ] **Step 4: 实现 client.ts**

Create `mycli-web/src/extension/rpc/client.ts`:
```ts
import { ClientCmd, AgentEvent, Envelope } from './protocol'
import type { z } from 'zod'

type AnyCmd = z.infer<typeof ClientCmd>
type AnyEvt = z.infer<typeof AgentEvent>

type AckResult = { ok: true } | { ok: false; error: { code: string; message: string } }

export interface RpcClientOptions {
  portName: string
  sessionId?: string
  ackTimeoutMs?: number
  reconnect?: boolean
}

export class RpcClient {
  private port: chrome.runtime.Port | null = null
  private readonly portName: string
  public readonly sessionId: string
  private readonly ackTimeoutMs: number
  private readonly reconnect: boolean
  private pendingAcks = new Map<string, { resolve: (r: AckResult) => void; timer: ReturnType<typeof setTimeout> }>()
  private handlers = new Map<AnyEvt['kind'], Set<(ev: AnyEvt) => void>>()
  private connected = false
  private retryDelay = 1000

  constructor(options: RpcClientOptions) {
    this.portName = options.portName
    this.sessionId = options.sessionId ?? crypto.randomUUID()
    this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000
    this.reconnect = options.reconnect ?? true
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      const p = chrome.runtime.connect({ name: this.portName })
      this.port = p
      this.connected = true
      p.onMessage.addListener((raw) => this._onMessage(raw))
      p.onDisconnect.addListener(() => this._onDisconnect())
      // Give the mock/chrome a microtask to propagate connection.
      queueMicrotask(() => resolve())
    })
  }

  private _onMessage(raw: unknown) {
    const parsed = AgentEvent.safeParse(raw)
    if (!parsed.success) return
    const ev = parsed.data
    if (ev.kind === 'command/ack') {
      const p = this.pendingAcks.get(ev.correlationId)
      if (p) {
        clearTimeout(p.timer)
        this.pendingAcks.delete(ev.correlationId)
        if (ev.ok) p.resolve({ ok: true })
        else p.resolve({ ok: false, error: ev.error ?? { code: 'unknown', message: '' } })
      }
      return
    }
    const set = this.handlers.get(ev.kind)
    if (set) for (const h of set) h(ev)
  }

  private _onDisconnect() {
    this.connected = false
    this.port = null
    // Reject all pending
    for (const [, p] of this.pendingAcks) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: { code: 'port_closed', message: 'Port disconnected before ack' } })
    }
    this.pendingAcks.clear()
    if (this.reconnect) {
      setTimeout(() => this.connect().catch(() => {}), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
    }
  }

  disconnect() {
    this.reconnect_ = false
    this.port?.disconnect()
  }

  // internal setter compat
  // biome-ignore lint/suspicious/noExplicitAny: simple setter
  private set reconnect_(v: boolean) {
    ;(this as any).reconnect = v
  }

  async send(partial: Omit<AnyCmd, 'id' | 'sessionId' | 'ts'>): Promise<AckResult> {
    const full = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      ts: Date.now(),
      ...partial,
    } as AnyCmd
    return this.sendRaw(full)
  }

  async sendRaw(cmd: unknown): Promise<AckResult> {
    if (!this.port) throw new Error('not connected')
    const id = (cmd as any)?.id ?? crypto.randomUUID()
    this.port.postMessage(cmd)
    return new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id)
        resolve({ ok: false, error: { code: 'ack_timeout', message: `no ack within ${this.ackTimeoutMs}ms` } })
      }, this.ackTimeoutMs)
      this.pendingAcks.set(id, { resolve, timer })
    })
  }

  on<K extends AnyEvt['kind']>(kind: K, handler: (ev: Extract<AnyEvt, { kind: K }>) => void) {
    if (!this.handlers.has(kind)) this.handlers.set(kind, new Set())
    this.handlers.get(kind)!.add(handler as any)
  }

  off<K extends AnyEvt['kind']>(kind: K, handler: (ev: Extract<AnyEvt, { kind: K }>) => void) {
    this.handlers.get(kind)?.delete(handler as any)
  }
}

// Re-export Envelope for consumers that need it directly.
export { Envelope }
```

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
bun run test -- rpc/hub
```
Expected: 2 tests PASS。

---

### Task 21: 补充 RPC 断线重连测试

**Files:**
- Modify: `mycli-web/tests/rpc/hub.test.ts`

- [ ] **Step 1: 加一条重连测试**

追加到 `mycli-web/tests/rpc/hub.test.ts`（文件末尾）：
```ts
import { vi } from 'vitest'

describe('RpcClient reconnect', () => {
  it('reconnects after port disconnect', async () => {
    vi.useFakeTimers()
    try {
      installHub({ mode: 'echo' })
      const client = new RpcClient({ portName: 'session', reconnect: true, ackTimeoutMs: 1000 })
      await client.connect()
      // Simulate disconnect from server side by disconnecting the client port.
      ;(client as any).port.disconnect()
      expect((client as any).connected).toBe(false)
      // Advance timers past the first retry (1000ms).
      await vi.advanceTimersByTimeAsync(1100)
      // After reconnect, sending should work again.
      const ack = await client.send({ kind: 'ping' })
      expect(ack.ok).toBe(true)
      client.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: 跑测试**

Run:
```bash
bun run test -- rpc/hub
```
Expected: 3 tests PASS（包含前面 2 条 + 新 1 条）。若重连测试因 mock 时序问题失败：放宽 `advanceTimersByTimeAsync` 到 2000ms 或额外加一次 `await vi.runAllTimersAsync()`。

---

## Section 8 — SW / Offscreen / Content / Options 入口

### Task 22: 写 Service Worker 入口

**Files:**
- Create: `mycli-web/src/extension/background.ts`

- [ ] **Step 1: 写 SW 入口（装 hub + action click + shortcut + offscreen 生命周期）**

Create `mycli-web/src/extension/background.ts`:
```ts
import { installHub } from './rpc/hub'
import { setTransientUi, getTransientUi } from './storage/transient'

const OFFSCREEN_URL = chrome.runtime.getURL('html/offscreen.html')

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [OFFSCREEN_URL],
  })
  if (contexts.length > 0) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['IFRAME_SCRIPTING' as chrome.offscreen.Reason],
    justification: 'Host agent runtime and sandbox iframes for code-capable skills.',
  })
}

async function activateOnTab(tabId: number): Promise<void> {
  await ensureOffscreen()
  const ui = await getTransientUi()
  const activatedTabs = { ...ui.activatedTabs, [String(tabId)]: true }
  await setTransientUi({ activatedTabs, panelOpen: true })
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'content/activate' })
  } catch {
    // content script 尚未加载（比如 chrome:// 页面）；忽略
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureOffscreen()
})

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen()
})

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) await activateOnTab(tab.id)
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-chat') return
  if (tab?.id) await activateOnTab(tab.id)
})

installHub({ mode: 'echo' })

// Log that SW is alive.
console.log('[mycli-web] background SW booted')
```

---

### Task 23: 写 Offscreen 入口

**Files:**
- Create: `mycli-web/src/extension/offscreen.ts`

- [ ] **Step 1: 占位 offscreen entry**

Create `mycli-web/src/extension/offscreen.ts`:
```ts
// Plan A: offscreen document 占位实现。Plan B 会在此宿主 QueryEngine + 工具派发。

console.log('[mycli-web] offscreen document booted at', new Date().toISOString())

// 预留：之后与 SW 建立一条 'sw<->offscreen' 的长连接 port。
// 目前仅响应 SW 发来的 keepalive ping，防止 offscreen 被回收（Plan A 不需要，但留钩子）。

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'offscreen/ping') {
    sendResponse({ kind: 'offscreen/pong', ts: Date.now() })
    return true
  }
  return false
})
```

---

### Task 24: 写 Content Script 入口 + FAB

**Files:**
- Create: `mycli-web/src/extension/content/index.ts`
- Create: `mycli-web/src/extension/content/fab.tsx`

- [ ] **Step 1: 写 FAB 组件**

Create `mycli-web/src/extension/content/fab.tsx`:
```tsx
import { useState } from 'react'

interface FabProps {
  onClick: () => void
  position: 'bottom-right' | 'bottom-left'
}

export function Fab({ onClick, position }: FabProps) {
  const [hovered, setHovered] = useState(false)
  const posClass = position === 'bottom-right' ? 'right-4 bottom-4' : 'left-4 bottom-4'
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`fixed ${posClass} h-12 w-12 rounded-full bg-blue-600 text-white shadow-lg transition-transform hover:scale-110`}
      style={{ zIndex: 2147483647 }}
      aria-label="mycli-web toggle chat"
    >
      <span className="text-sm font-semibold">{hovered ? 'mw' : '▲'}</span>
    </button>
  )
}

export function ChatShell() {
  return (
    <div
      className="fixed right-4 bottom-20 h-96 w-80 rounded-lg border border-slate-200 bg-white shadow-xl"
      style={{ zIndex: 2147483647 }}
    >
      <div className="flex h-10 items-center border-b border-slate-200 px-3 text-sm font-semibold text-slate-700">
        mycli-web (Plan A stub)
      </div>
      <div className="flex h-[calc(100%-2.5rem)] items-center justify-center text-sm text-slate-400">
        Chat UI coming in Plan B
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 写 content script 入口**

Create `mycli-web/src/extension/content/index.ts`:
```ts
import { createRoot } from 'react-dom/client'
import { StrictMode, useState, useEffect } from 'react'
import { Fab, ChatShell } from './fab'
import { RpcClient } from '../rpc/client'
import { getTransientUi, setTransientUi } from '../storage/transient'
import { loadSettings } from '../storage/settings'
import contentCss from '../../styles/content.css?inline'

async function mount() {
  const settings = await loadSettings()
  if (!settings.fab.enabled) return

  // 构建 Shadow DOM 宿主，隔离页面 CSS。
  const host = document.createElement('div')
  host.id = 'mycli-web-root'
  host.style.all = 'initial'
  document.documentElement.appendChild(host)
  const shadow = host.attachShadow({ mode: 'closed' })

  // 注入 Tailwind + 基础 reset。
  const styleEl = document.createElement('style')
  styleEl.textContent = contentCss
  shadow.appendChild(styleEl)

  const mountNode = document.createElement('div')
  mountNode.id = 'mycli-web-mount'
  shadow.appendChild(mountNode)

  const client = new RpcClient({ portName: 'session' })
  await client.connect()

  function App() {
    const [open, setOpen] = useState(false)
    useEffect(() => {
      getTransientUi().then((s) => setOpen(s.panelOpen))
      const listener = (msg: any) => {
        if (msg?.kind === 'content/activate') setOpen(true)
      }
      chrome.runtime.onMessage.addListener(listener)
      return () => chrome.runtime.onMessage.removeListener(listener)
    }, [])

    async function toggle() {
      const next = !open
      setOpen(next)
      await setTransientUi({ panelOpen: next })
    }

    return (
      <StrictMode>
        <Fab onClick={toggle} position={settings.fab.position} />
        {open && <ChatShell />}
      </StrictMode>
    )
  }

  createRoot(mountNode).render(<App />)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount())
} else {
  mount()
}
```

---

### Task 25: 写 Options 页入口

**Files:**
- Create: `mycli-web/src/extension/options/OptionsApp.tsx`

- [ ] **Step 1: 写 options 页**

Create `mycli-web/src/extension/options/OptionsApp.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import { StrictMode, useEffect, useState } from 'react'
import { loadSettings, saveSettings, type Settings } from '@ext/storage/settings'

function OptionsApp() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    loadSettings().then(setSettings)
  }, [])

  if (!settings) return <div className="p-6">Loading…</div>

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!settings) return
    await saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold">mycli-web settings</h1>
      <p className="mt-1 text-sm text-slate-500">Plan A — minimal settings form.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="block text-sm font-medium">API key</span>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Base URL</span>
          <input
            type="text"
            value={settings.baseUrl}
            onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Model</span>
          <input
            type="text"
            value={settings.model}
            onChange={(e) => setSettings({ ...settings, model: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
          {saved && <span className="text-sm text-green-600">Saved ✓</span>}
        </div>
      </form>
    </div>
  )
}

const root = document.getElementById('options-root')!
createRoot(root).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
)
```

---

## Section 9 — 构建 / Typecheck / 手工烟测

### Task 26: 通过 typecheck 与构建

- [ ] **Step 1: typecheck**

Run:
```bash
cd /Users/heguicai/myProject/mycli-web
bun run typecheck
```
Expected: 无 TS 错误。若报错（通常是 types/chrome 引入问题或 path alias），修到通过。

- [ ] **Step 2: 开发构建**

Run:
```bash
bun run build
```
Expected: Vite 打包成功，产物出现在 `dist/`：
- `dist/manifest.json`
- `dist/assets/*`（background、content、offscreen、options 各自 bundle）
- `dist/html/offscreen.html`、`options.html`、`sandbox.html`

若构建失败（通常是 manifest 字段被 @crxjs 拒绝、或 content script 入口 js 不能是 .ts 直接引用），参考 @crxjs 最新文档修正 manifest 的 `content_scripts.js` 是 `.ts` 源路径（@crxjs 会在构建时重写）。

- [ ] **Step 3: 全量 test 跑一遍**

Run:
```bash
bun run test
```
Expected: 全部绿；task 10-21 加起来 30+ 条测试。

---

### Task 27: Chrome 手工加载并烟测

**目标：** 确认 Plan A 的端到端流程在真实 Chrome 里工作。

- [ ] **Step 1: 打开 Chrome 扩展管理页**

Run（让用户手工操作）：在 Chrome 地址栏输入：
```
chrome://extensions
```
打开开发者模式（右上角 toggle）。

- [ ] **Step 2: "Load unpacked"**

点击 "Load unpacked"，选择 `/Users/heguicai/myProject/mycli-web/dist/` 目录。
Expected: 扩展显示为 "mycli-web"，版本 `0.1.0`，状态 enabled。无红色错误横幅。

若出现 manifest 错误："检查并修复，重新 build，点击扩展卡片上的 'Reload'"。

- [ ] **Step 3: 验证 SW 活**

在 `chrome://extensions` 的 mycli-web 卡片上，点击 "Service Worker"（或 "Inspect views: service worker"）。
Expected: DevTools Console 显示 `[mycli-web] background SW booted`。

- [ ] **Step 4: 验证 FAB 出现**

在浏览器新 tab 打开 `https://example.com`。
Expected: 页面右下角出现蓝色圆形浮标。若没出现，打开 DevTools Console 查错（通常是 Shadow DOM 样式问题或 React 未挂载）。

- [ ] **Step 5: 验证 FAB 可点开 ChatShell**

点击浮标。
Expected: 浮标上方出现占位 chat 框，标题 "mycli-web (Plan A stub)"。再点击 FAB 可收起。

- [ ] **Step 6: 验证快捷键**

按 `Cmd+Shift+K`（Mac）或 `Ctrl+Shift+K`（Win/Linux）。
Expected: ChatShell 切换显示。

- [ ] **Step 7: 验证 options 页**

在 `chrome://extensions` 的 mycli-web 卡片上点 "Details" → "Extension options"。
Expected: 显示 "mycli-web settings" 页，三个字段（API key / Base URL / Model）可编辑；点 "Save" 显示 "Saved ✓"。

- [ ] **Step 8: 验证 offscreen 活**

回到 SW DevTools Console，执行：
```js
chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
```
Expected: 返回数组长度为 1，包含 offscreen document 上下文。

- [ ] **Step 9: 验证 RPC 端到端（content → SW ack）**

在 `https://example.com` 的页面 DevTools Console（不是 SW 的，不是 offscreen 的）中，Shadow DOM 之外通常拿不到 RpcClient 实例。改为在 SW Console 看日志：每次 content script 连接会触发 `onConnect`。

或者更直接：在 SW Console 执行：
```js
chrome.runtime.getContexts({ contextTypes: ['TAB'] })
```
Expected: 包含 example.com tab 的 context。

Plan A 的 RPC 端到端验证到此为止；深度验证留给 Plan B 的 Playwright E2E。

- [ ] **Step 10: 关扩展**

点击扩展卡片的 "Remove" 或 "Disable"，清掉本地试验状态。

---

## Section 10 — Git 初始化与首个 commit

### Task 28: git init 并把 spec 文件移入

- [ ] **Step 1: 写 .gitignore**

Create `mycli-web/.gitignore`:
```
node_modules/
dist/
.DS_Store
*.log
coverage/
.vitest/
```

- [ ] **Step 2: 把 spec 从上级目录挪进来**

Run:
```bash
cd /Users/heguicai/myProject
mkdir -p mycli-web/docs/superpowers/specs
mv docs/superpowers/specs/2026-04-24-mycli-web-design.md mycli-web/docs/superpowers/specs/
# 同样把 Plan A 本文件也挪进去，保持计划文档与项目一起
mkdir -p mycli-web/docs/superpowers/plans
mv docs/superpowers/plans/2026-04-24-mycli-web-plan-a-scaffolding.md mycli-web/docs/superpowers/plans/
# 清空现在已经为空的上级 docs
rmdir docs/superpowers/specs docs/superpowers/plans docs/superpowers docs 2>/dev/null || true
```
Expected: 验证：
```bash
ls mycli-web/docs/superpowers/specs/
ls mycli-web/docs/superpowers/plans/
```
都应看到对应 .md。

- [ ] **Step 3: 写 README.md（覆盖原 mycli README）**

Create `mycli-web/README.md`:
```markdown
# mycli-web

A Chrome MV3 browser-agent extension, forked from [mycli](../my-cli) and rebuilt web-first.

## Status

Plan A scaffolding complete:
- Chrome extension loads as unpacked
- FAB appears on pages; keyboard shortcut `Cmd/Ctrl+Shift+K` toggles chat shell
- Options page persists settings via `chrome.storage.local`
- Storage layer (IndexedDB + chrome.storage) ready with full test coverage
- RPC protocol (content ↔ SW, Zod-validated) round-trips ping/pong

Plan B (agent core port + read tools + minimal chat UI) is next.

## Develop

Prereqs: bun ≥ 1.3.5, Node ≥ 24, Chrome.

```bash
bun install
bun run build
```

Load `dist/` via `chrome://extensions` → "Load unpacked".

Run tests:

```bash
bun run test
```

See `docs/superpowers/specs/` for full design and `docs/superpowers/plans/` for sequenced implementation plans.
```

- [ ] **Step 4: git init + 初始 commit**

Run:
```bash
cd /Users/heguicai/myProject/mycli-web
git init
git add .
git -c user.name="mycli-web" -c user.email="noreply@local" commit -m "Plan A: scaffolding + RPC + storage

- Forked mycli-web from my-cli, stripped CLI/TUI/Node-only paths
- Vite + @crxjs/vite-plugin + React 18 + Tailwind build toolchain
- MV3 manifest (offscreen, sandbox pages, commands, host permissions)
- Content script with Shadow DOM FAB + placeholder chat shell
- Background SW + offscreen document lifecycle
- Options page wired to chrome.storage.local
- Zod-validated RPC protocol (ClientCmd / AgentEvent / DomOp / Envelope)
- RPC hub (echo mode) + RpcClient with reconnect + ack timeout
- IndexedDB schema v1 (conversations, messages, skills, skillData, auditLog)
- Settings + approval rules in chrome.storage.local; transient UI in session
- 30+ unit + contract tests, all green
"
```
Expected: 提交成功，返回 commit hash。

- [ ] **Step 5: 最终验收**

Run:
```bash
cd /Users/heguicai/myProject/mycli-web
git log --oneline
bun run test --reporter=basic 2>&1 | tail -5
ls dist/ 2>/dev/null || bun run build
```
Expected:
- `git log` 显示 1 条初始 commit
- 测试通过数稳定（~30+ 条）
- `dist/` 存在且包含 manifest.json

---

## Plan A 完成标准

执行完以上 28 个 Task 后，以下状态**必须**成立：

- [ ] `mycli-web/` 是独立 git 仓库，包含 1 个干净的 initial commit
- [ ] `bun install` 无错误、`bun run build` 产出可加载 `dist/`
- [ ] `bun run typecheck` 与 `bun run test` 都绿
- [ ] Chrome 加载 `dist/` 后 FAB 可见、可点、快捷键可切换 chat shell
- [ ] Options 页保存 API key 后重新打开可见
- [ ] Service Worker 和 Offscreen Document 都处于活跃状态
- [ ] 30+ 条单元测试覆盖：protocol schema / IndexedDB 5 个 store / chrome.storage.local settings + rules / chrome.storage.session transient / RPC hub round-trip + 重连
- [ ] Spec 与 Plan A 文档都迁入 `mycli-web/docs/superpowers/`

完成后即可进入 **Plan B：Agent 核心 + 读工具 + 最小聊天 UI**。
