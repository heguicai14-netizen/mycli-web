# Agent Kernel 抽核交接备忘 — 2026-05-10

## 一句话总结

**抽核完成**。仓变成 Bun workspace 两个包（`packages/agent-kernel/` + `packages/mycli-web/`）。kernel 是可被任何 Chrome MV3 扩展直接 `import 'agent-kernel'` 使用的库，mycli-web 退化成 reference consumer。25 个 task 按 plan 全做完，~30 个 commit，cold typecheck 干净，144 个测试全过（kernel 110 + mycli-web 34），真 LLM 端到端验证通过。

## 跑了什么

- **25 个 plan tasks 全部完成**（spec + plan + 抽核全程都已 commit）
- **6 批 subagent 顺序执行**（每批 typecheck + test + build 全绿才进下一批）
- **1 次中途修复**：T12-T15 subagent 漏检 cold-cache typecheck 失败，我手动定位到根因（bun workspace 没把 `@types/chrome` 提升到根 + `extension-skills` tsconfig 缺 chrome 类型），单 commit 修了
- **Final cold-cache 验证**：typecheck/test/build/live 全过

## 现在的工作区结构

```
mycli-web/                        ← 仓根（Bun workspace 根）
├── package.json                  ← workspaces: ["packages/*"]
├── tsconfig.json                 ← references: agent-kernel + mycli-web
├── docs/                         ← spec / plan / handoff / architecture / agent-integration
├── packages/
│   ├── agent-kernel/             ← 库包（不发 npm）
│   │   ├── src/
│   │   │   ├── core/             ← LLM loop / tool 协议 / 注册表
│   │   │   ├── browser/          ← Chrome MV3 装配 helper / RPC / SDK
│   │   │   │   ├── rpc/          ← hub + client + protocol
│   │   │   │   ├── agentClient/  ← createAgentClient SDK（含心跳）
│   │   │   │   ├── agentService.ts  ← 编排层（接受三个 adapter）
│   │   │   │   ├── installKernelBackground.ts  ← SW 装配 helper
│   │   │   │   ├── bootKernelOffscreen.ts      ← offscreen 装配 helper
│   │   │   │   ├── domOpClient.ts / domOpRouter.ts
│   │   │   │   ├── offscreenChromePolyfill.ts
│   │   │   │   └── storage/      ← 默认 IDB MessageStore（DB='agent-kernel'）
│   │   │   ├── adapters/         ← Settings / MessageStore / ToolContext 接口
│   │   │   ├── skills/           ← Skill 协议 + 元工具 factory + viteGlob/fs loaders
│   │   │   ├── tools/fetchGet.ts ← 唯一 built-in 跨环境工具
│   │   │   ├── errors.ts         ← ErrorCode + classifyError
│   │   │   └── index.ts          ← 公开 API 唯一入口
│   │   ├── tests/
│   │   ├── docs/                 ← README + getting-started + api-reference + adapters
│   │   ├── package.json          ← name: "agent-kernel"
│   │   └── tsconfig.json
│   │
│   └── mycli-web/                ← reference Chrome 扩展
│       ├── src/
│       │   ├── extension/
│       │   │   ├── background.ts        ← ~22 行调 installKernelBackground
│       │   │   ├── offscreen.ts         ← ~50 行调 bootKernelOffscreen
│       │   │   ├── settingsAdapter.ts   ← 实现 SettingsAdapter
│       │   │   ├── content/, ui/, options/
│       │   │   └── storage/             ← chrome.storage 包装（settings/transient/rules）
│       │   ├── extension-tools/         ← readPage、screenshot、tabs 等业务工具
│       │   ├── extension-skills/        ← bundled summarizePage skill
│       │   └── styles/
│       ├── tests/
│       ├── scripts/agent-repl.ts        ← Bun CLI demo（用 kernel fsLoader）
│       ├── manifest.json, vite.config.ts, vitest.config.ts
│       └── package.json                 ← deps: "agent-kernel": "workspace:*"
```

## 怎么验证

### 路径 1：CLI（不开 Chrome）

```bash
cd packages/mycli-web
bun run agent:repl
> 用 summarizePage skill 总结这段："Bunnies have long ears."
```

应该看到 `useSkill` 被调用、skill body 加载、最终输出 markdown bullet。

### 路径 2：Chrome 扩展

```bash
cd packages/mycli-web
bun run build
```

然后 `chrome://extensions` 重载，任意网页强刷，唤出聊天，发：

```
用 summarizePage skill 总结这页
```

### 路径 3：完整测试矩阵（cold cache）

```bash
cd /Users/heguicai/myProject/mycli-web
rm -rf node_modules/.cache/tsc
bun run typecheck                       # exit 0
cd packages/agent-kernel && bun run test  # 110 passed
cd ../mycli-web && bun run test           # 34 passed + 8 skipped
bun run build                             # built
```

### 路径 4：真 LLM 端到端

```bash
cd packages/mycli-web
MYCLI_TEST_API_KEY=... MYCLI_TEST_BASE_URL=... MYCLI_TEST_MODEL=... \
  bun run test tests/integration/agent.live.test.ts -t "skill flow"
```

刚才用 GLM-4.6 跑过，3.3s 通过。

## 给第 2 个新扩展用 kernel 怎么办

新建 `packages/<your-extension>/` 目录，按 `packages/agent-kernel/docs/getting-started.md` 5 分钟教程：

1. `package.json` 加 `"agent-kernel": "workspace:*"`
2. 写 `manifest.json`（你的 permissions 和 entry points）
3. `background.ts` ≈ 10 行调 `installKernelBackground`
4. `offscreen.ts` ≈ 30 行调 `polyfillChromeApiInOffscreen` + `bootKernelOffscreen`
5. content 入口用 `createAgentClient` 跟 agent 聊天
6. 把你的工具加进 `bootKernelOffscreen` 的 `tools` 数组
7. 把你的 skill `.md` 文件加进 `loadSkillsFromViteGlob` 路径

`bun install` → `bun run build` → load unpacked → 完成。

## 三个 adapter 接口

消费方必须实现 `SettingsAdapter`，可选实现另外两个：

```ts
// 必须
interface SettingsAdapter {
  load(): Promise<Settings>   // { apiKey, baseUrl, model, ... }
}

// 默认 createIdbMessageStore 够用；想自己存就实现
interface MessageStoreAdapter {
  activeConversationId / append / list / update
}

// 自己工具需要什么 ctx 字段（tabId 等）就 build 啥
interface ToolContextBuilder<Ctx> {
  build(cid?: string): Promise<Ctx>
}
```

详细实现指南见 `packages/agent-kernel/docs/adapters.md`。

## Tier 1 稳定性增强（也包在抽核里）

- **LLM fetch 超时**：`OpenAICompatibleClient` 加 `fetchTimeoutMs?: number`，默认 60s，到点强制 abort。
- **错误分类**：`ErrorCode` 枚举（network/auth/rate_limit/bad_request/server/timeout/abort/tool_error/schema/unknown）+ `classifyError(e)` helper。OpenAI client 的所有抛出现在都包过 classifyError，QueryEngine 的 `done.error.code` 自动带分类码。
- **心跳**：`createAgentClient` 默认 25s 自动 ping 维持 SW 活；可设 `heartbeatMs: 0` 关闭。

## 改了哪些文件 / 新增了哪些 commit

完整 commit 链（按时间倒序，从最新的修复回到抽核起点）：

```
3668a1c docs: update architecture + integration guides for workspace + kernel
39c3668 docs(agent-kernel): adapters guide
2c8f904 docs(agent-kernel): API reference
1083978 docs(agent-kernel): getting-started guide
eb5e9ce docs(agent-kernel): README
d84b9d1 feat(agent-kernel): OpenAICompatibleClient wraps errors via classifyError; QueryEngine forwards code
a162a04 feat(agent-kernel): ErrorCode taxonomy + classifyError helper
626aef1 feat(agent-kernel): configurable fetchTimeoutMs on OpenAICompatibleClient
<fix> fix(workspace): cold-cache typecheck regression after T12-T15 (我手动加 chrome types)
031ee0d feat(agent-kernel): skill loaders (viteGlob + fs) exported from kernel
40f2f03 feat(agent-kernel): heartbeat in createAgentClient (default 25s)
8401c4a feat(agent-kernel): bootKernelOffscreen helper; mycli-web offscreen.ts ~50 lines
ebdce40 feat(agent-kernel): installKernelBackground helper; mycli-web background.ts ~22 lines
0dacbe5 feat(agent-kernel): ToolContextBuilder adapter
4874816 feat(agent-kernel): MessageStoreAdapter + default createIdbMessageStore
4d1193d feat(agent-kernel): SettingsAdapter interface
ea892bc refactor: move agent-core tests into agent-kernel/tests/core
abbb228 refactor: move conversations/messages/auditLog stores into agent-kernel/browser/storage
dc3e7be refactor: extract agentService + dom op helpers into agent-kernel
656e843 refactor: extract rpc + agentClient into agent-kernel/browser
285b0cf refactor: relocate skills/ subpackage in agent-kernel
1091719 refactor: extract agent-core into agent-kernel package
8e67a60 chore: scaffold packages/agent-kernel + workspace dep wiring
09400ac chore: move project into packages/mycli-web for workspace setup
bc60300 docs: agent-kernel extraction implementation plan (25 tasks, 5 phases)
f873373 docs: agent-kernel extraction design spec
7b6ec71 chore: checkpoint pre-existing session work before kernel extraction
```

## 已知问题 / 注意事项

### 不影响功能

1. **`bun --cwd <dir> run <script>` 不工作** — 是 Bun 自己的怪行为（不是 flag）。所有命令用 `cd <dir> && bun run <script>` 代替。CLAUDE.md 里的 `bun --cwd` 例子需要改（可以列为 follow-up）。
2. **Cold-cache typecheck 必须 `rm -rf node_modules/.cache/tsc`** — 否则 tsc 用增量缓存可能掩盖问题。CI / 验收脚本都该带 cold cache。
3. **getting-started.md 引用了不存在的 error-handling.md** — plan 提了但没 task 写，subagent 留了链接。要么补一篇 doc，要么把链接拿掉。
4. **`pushSnapshot` 现在用通用 title `'Conversation'`** — kernel 不知道消费方有没有 conversation title 字段。如果消费方想自定义，包一层 messageStore 或将来给 MessageStoreAdapter 加可选 `getConversationTitle`。
5. **Heartbeat 同时存在两份** — kernel 的 `createAgentClient` 内置 25s 心跳；mycli-web 的 `ChatApp.tsx` 也有自己的心跳（因为它直接用 `RpcClient` 不通过 SDK）。两份不冲突，删掉 ChatApp 那份等 ChatApp 重构走 SDK 时再做。

### 比较细节的事

6. **`extension-skills/tsconfig.json` 加了 chrome 类型**（修 cold-cache regression 那个 commit）。原因是它 transitively 拉到 kernel browser 类型。如果将来想纯净化，可以让 kernel 把 browser/* 拆成单独入口（`agent-kernel/browser`），让纯协议的消费方只 import skill protocol 部分，避免拉 chrome 类型。
7. **kernel `index.ts` 把 `AgentEvent` 从 core 重导，把 `AgentEvent` 从 wire 起别名 `WireAgentEvent`** — 避免命名冲突。新 consumer 要注意区分。
8. **TypeScript project references 模型不完美**：mycli-web 子包没把 agent-kernel 列为 TS reference，所以读 kernel 是 follow workspace 符号链接读源码，会被 mycli-web 子包的 tsconfig 设置覆盖一次。理想方案是 kernel 编译出 `.d.ts` 到一个固定路径，mycli-web 引用 `.d.ts` 而不是源码——但这需要 build pipeline 改。当前能用就先这样。

## 下一步建议

按价值排序：

1. **第 2 个 kernel 消费方扩展**：现在跑出真实需求，看 adapter 接口是否够用、helper 体验是否真好。这是抽核的核心交付价值。
2. **删 ChatApp 自己的心跳**（同时改用 createAgentClient SDK）：~50 行减 20 行，统一心跳来源。半天活。
3. **补 error-handling.md**：把 ErrorCode + classifyError + runtime/error event + cancel 语义写一篇专门的指南。半天。
4. **kernel build pipeline**：emit `.d.ts` 到 `packages/agent-kernel/dist/` 之类的固定路径，让 mycli-web 引用 declarations 而不是源码——避免 cold-cache 的 chrome 类型连带问题。1-2 天。
5. **Tier 2**：sub-agent、代码型 skill、provider 多家、用户安装 skill。这些还在 spec 的 forward-compat 段，正式做之前再走一轮 brainstorming。

## 给我的话

如果早上发现问题：
- **首先跑** path 3（cold cache 完整验证），确认 baseline 是否还绿
- **如果 typecheck cold-cache 红**：很可能是某个 tsconfig 的 types 缺了 chrome 或 vite/client，或者 typeRoots 漏了某个路径
- **如果 test 红**：先看是 kernel 测试还是 mycli-web 测试，定位到具体文件
- **如果 build 红**：vite + crxjs 的 manifest input 路径可能有问题

debug 顺序 typecheck → test → build → live → 浏览器手动。

晚安。
