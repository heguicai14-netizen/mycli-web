# mycli-web

A Chrome MV3 browser-agent extension, forked from [mycli](../my-cli) and rebuilt web-first.

## Status

**Plan A scaffolding complete:**
- Chrome extension builds via `bun run build` and loads as unpacked
- FAB appears on pages; keyboard shortcut `Cmd/Ctrl+Shift+K` toggles chat shell
- Options page persists settings via `chrome.storage.local`
- Storage layer (IndexedDB + chrome.storage) ready with full test coverage
- RPC protocol (content ↔ SW) round-trips ping/pong with ack timeout + reconnect
- 43 unit + contract tests, all green

**Plan B** (agent core port + read tools + minimal chat UI) is next.

## Develop

Prereqs: **bun ≥ 1.3.5**, **Node ≥ 24**, Chrome.

```bash
bun install
bun run build
```

Load `dist/` via `chrome://extensions` → enable Developer mode → "Load unpacked".

Run tests:

```bash
bun run test        # 43 tests
bun run typecheck   # zero errors
```

## Layout

```
src/
  shared/           共享类型
  extension/
    background.ts   Service Worker 入口
    offscreen.ts    Offscreen document 入口（Plan B 将 host 起 QueryEngine）
    content/        Content script + Shadow DOM 浮窗（React）
    options/        扩展选项页
    rpc/            Zod 协议 + hub + RpcClient（重连、ack 超时）
    storage/        IndexedDB（对话/消息/skill/skillData/审计日志）
                    + chrome.storage（settings / 审批规则 / 瞬态 UI）
tests/              vitest + fake-indexeddb + chrome.* mock
html/               offscreen / options / sandbox HTML 壳
public/icons/       扩展图标（占位）
docs/superpowers/   设计文档与分阶段计划
```

## 架构要点

- **Offscreen Document** 宿主长期运行的 agent runtime 与 skill sandbox iframe（Plan B/F 填充）
- **Service Worker** 做 RPC 路由 + `chrome.*` API 代理 + 审批队列中介
- **Content Script** 通过 Shadow DOM（closed mode）隔离页面 CSS，仅负责 UI 和页面级 DOM 操作
- 所有跨进程消息经 Zod 校验；RpcClient 自动指数退避重连、30s ack 超时
- LLM provider 只做 OpenAI-compatible（`apiKey` / `baseUrl` / `model`）

详细设计见 `docs/superpowers/specs/2026-04-24-mycli-web-design.md`。  
分阶段计划见 `docs/superpowers/plans/`。

## 加载到 Chrome

1. `bun run build` 产出 `dist/`
2. Chrome 打开 `chrome://extensions`
3. 右上角打开 "Developer mode"
4. 点击 "Load unpacked"，选择 `dist/`
5. 打开任意网页，右下角会出现 FAB；或按 `Cmd+Shift+K`（Mac）/ `Ctrl+Shift+K` 切换浮窗
6. 点扩展卡片 "Details" → "Extension options" 可打开设置页

## License

SEE LICENSE IN LICENSE.md (inherited from mycli fork).
