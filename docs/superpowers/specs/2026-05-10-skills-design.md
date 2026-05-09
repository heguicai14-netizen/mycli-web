# Skills 设计

状态：spec，待实施
日期：2026-05-10

## 概述

为 agent 加上**只打包、纯文本**的 skills 能力。一个 skill 是一个文件夹，
含必需入口 `SKILL.md` 和可选的参考文档。LLM 通过元工具按需加载 skill，
然后用 agent 现有的工具集执行其中指令。格式遵循 Claude Code skill 标准，
**不**支持代码执行（`scripts/`、`tools.js`、sandbox 全部不在范围）。

## 目标

- 开发者向 `src/extension-skills/skills/` 丢一个文件夹即可扩展 agent 行为，
  不需要改任何注册代码。
- LLM 通过单一元工具 `useSkill` 自主决定何时加载哪个 skill，机制跟
  调用普通工具完全一致。
- skill 格式跟 Claude Code 标准前向兼容，将来扩展到代码型 skill 是叠加，
  不是重做。
- 一开始就支持多个 bundled skill；加第 N+1 个 skill 是零代码改动。

## 不在范围（本次发布）

- 用户运行时安装 skill（上传、粘贴、URL 拉取）。
- 代码执行：不支持 `scripts/`、不支持 `tools.js`、不引入 sandbox iframe。
- 单 skill 的工具白名单 / 配额 / 凭据声明。
- frontmatter 的 `tags` 分组 / 懒列表。
- skill 版本管理、签名分发、依赖声明。

这些都没有架构层面的阻塞——见 "前向兼容" 一节——只是有意延后。

## 架构

```
┌─ agent-core（平台无关）─────────────────────────────────────────┐
│  Skill.ts          SkillDefinition + parseSkillMd(raw, path)    │
│  SkillRegistry.ts  register / get / list / addFile              │
│  useSkillTool.ts   createUseSkillTool({ registry })             │
│  readSkillFileTool.ts  createReadSkillFileTool({ registry })    │
└─────────────────────────────────────────────────────────────────┘
                          ▲ 被引用
                          │
┌─ extension-skills/（chrome 侧，glob 单点）──────────────────────┐
│  skills/                                                        │
│    summarizePage/                                               │
│      SKILL.md                                                   │
│      references/style.md                                        │
│  index.ts          ★ 整个项目里唯一使用 import.meta.glob 的地方 │
│                    构建 registry，导出两个工具（已绑 registry）  │
└─────────────────────────────────────────────────────────────────┘
                          ▲ 被引用
                          │
┌─ extension/agentService.ts（装配层）────────────────────────────┐
│  把 useSkillTool + readSkillFileTool 加进每轮传给 createAgent   │
│  的工具列表里。                                                  │
└─────────────────────────────────────────────────────────────────┘
```

`agent-core` 不知道 vite 也不知道哪些 skill 被打包；`extension-skills` 是
唯一接触 `import.meta.glob` 的地方；从外部看只导出两个工具。

## Skill 格式

一个 skill 是 `src/extension-skills/skills/` 下的一个文件夹。**文件夹名
必须等于 skill 在 frontmatter 里的 `name` 字段**——不一致的话 build 时
loader 报错。

- 必需：根目录下 `SKILL.md`
- 可选：任意位置（含子目录）的其他 `.md` 文件
- 约束：skill 文件夹本身**恰好一层深**（`skills/<name>/...`，`<name>` 内部
  可以有子目录；`skills/foo/bar/SKILL.md` 这种嵌套 skill **不支持**）

```
src/extension-skills/skills/
  summarizePage/
    SKILL.md                      # 必需入口
    references/
      style.md                    # 可选：语气/长度规约
      examples.md                 # 可选：标杆输出
```

`SKILL.md` 形状：

```md
---
name: summarizePage
description: Summarize the currently active web page in three bullet points.
---

# Instructions

1. Call `readPage` with mode `'text'` to get the page content.
2. Identify the three most important points.
3. Reply with a markdown bullet list. Bold key terms.
4. If the page is too short, return what you can rather than fabricating.

For tone and length conventions, call `readSkillFile` with
`{ skill: 'summarizePage', path: 'references/style.md' }`.
```

frontmatter 解析规则（MVP）：
- 用文件开头的 `---` 单行分隔上下两块。
- 一行一个 `key: value`，**只支持字符串值**。
- 必填 key：`name`、`description`，缺或空 → loader 报错。
- 未知 key 保留进 `SkillDefinition.meta`，不参与逻辑。
- 不支持嵌套、数组、引号转义。将来要换成真 YAML 解析器时，对消费方
  零改动。

允许 SKILL.md 没有 body（只有 frontmatter），`body` 字段就是空字符串，
loader 不报错。

## 类型

```ts
// agent-core/Skill.ts
export interface SkillDefinition {
  name: string
  description: string
  body: string                         // SKILL.md frontmatter 之后的全部内容
  files: Record<string, string>        // 其他文件，key 是相对路径，如 'references/style.md'
  meta?: Record<string, string>        // 未知的 frontmatter 字段，原样保留
}

export function parseSkillMd(
  raw: string,
  sourcePath: string,
): { name: string; description: string; body: string; meta: Record<string, string> }
```

`parseSkillMd` 是纯函数；`sourcePath` 仅用于错误信息。

## SkillRegistry

```ts
// agent-core/SkillRegistry.ts
export class SkillRegistry {
  register(skill: SkillDefinition): void   // 重名抛错
  get(name: string): SkillDefinition | undefined
  list(): SkillDefinition[]                // 稳定顺序，按 name 字典序
  addFile(skillName: string, relPath: string, content: string): void  // 给 loader 用
}
```

仅在内存中持有。无持久化。模块加载时重建。

## 加进 agent 的两个工具

### `useSkill`

```
入参：{ skill: string }   // 必须是已注册 skill 的 name
返回：ToolResult<string>  // skill body + 自动追加的相关文件清单
```

description 每轮按 registry 内容动态拼装：

```
Loads a specialized skill's instructions when the user's request matches one.
After calling, follow the returned instructions using your other tools.

Available skills:
 • summarizePage — Summarize the currently active web page in three bullet points.
 • <下一个 skill> — <它的 description>
 ...

Call useSkill with the exact skill name. The result will be your instructions.
```

执行：
- 按 name 查找。未命中 → `{ ok: false, error: { code: 'unknown_skill', message: ... } }`
- 命中 → `{ ok: true, content: <body> + appendedManifest }`

`appendedManifest` 由 `skill.files` 自动生成，无参考文件时省略：

```
---
Related files in this skill (call readSkillFile to load):
  - references/style.md
  - references/examples.md
```

### `readSkillFile`

```
入参：{ skill: string, path: string }   // path 相对于 skill 文件夹根
返回：ToolResult<string>
```

description 自动拼装：

```
Read a reference file from a skill's folder. Use after useSkill suggested a
related file. The path is relative to the skill folder (e.g. 'references/style.md').

Files available:
  summarizePage/references/style.md
  summarizePage/references/examples.md
  ...
```

执行：
- 未知 skill → `unknown_skill` 错误。
- 路径不在该 skill 的 `files` 里 → `unknown_path` 错误。
- 命中 → `{ ok: true, content: <文件文本> }`。

## Loader（extension-skills/index.ts）

整个项目唯一接触文件系统的地方，约 15 行：

```ts
import {
  SkillRegistry,
  parseSkillMd,
  createUseSkillTool,
  createReadSkillFileTool,
} from '@core'

const modules = import.meta.glob('./skills/**/*.md', {
  query: '?raw', eager: true, import: 'default',
}) as Record<string, string>

const registry = new SkillRegistry()

// 按 skill 文件夹名分组；先注册 entry，再注册 reference 文件
const byFolder = groupByFolder(modules)              // 见下
for (const [folderName, files] of byFolder) {
  const entryRaw = files['SKILL.md']
  if (!entryRaw) {
    throw new Error(`skill '${folderName}' is missing SKILL.md`)
  }
  const parsed = parseSkillMd(entryRaw, `${folderName}/SKILL.md`)
  if (parsed.name !== folderName) {
    throw new Error(
      `skill folder '${folderName}' frontmatter name='${parsed.name}' must match folder name`,
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
    registry.addFile(folderName, relPath, content)
  }
}

export const skillRegistry = registry
export const useSkillTool = createUseSkillTool({ registry })
export const readSkillFileTool = createReadSkillFileTool({ registry })
```

`groupByFolder` 是一个小工具：把 `'./skills/foo/SKILL.md'`、
`'./skills/foo/references/x.md'` 这种路径转成
`{ foo: { 'SKILL.md': raw, 'references/x.md': raw } }`，第一级目录段
之后的部分整体作为相对路径 key。

要换 skill 根路径时，改这一句 `import.meta.glob` 即可，所有消费方
不用动。

## 装配

`src/extension/agentService.ts` 把两个工具拼进默认工具列表：

```ts
import { useSkillTool, readSkillFileTool } from '@/extension-skills'

const allTools = deps.tools ?? [
  fetchGetTool,
  ...extensionTools,
  useSkillTool,
  readSkillFileTool,
]
```

每轮请求里 `cmd.tools` allowlist 仍然有效——调用方可以显式包含或排除
这两个 skill 工具的名字。

## 行为流程示例 — "总结这个页面"

```
1. 用户："总结这个页面"
2. LLM 看到工具列表（现有工具 + useSkill + readSkillFile）。
3. useSkill 描述里列出 'summarizePage'。LLM 调用
   useSkill({skill: 'summarizePage'}).
4. 工具返回：
       # Instructions
       1. Call readPage with mode 'text' ...
       ...
       For tone, call readSkillFile with { skill: 'summarizePage',
       path: 'references/style.md' }.
       ---
       Related files in this skill (call readSkillFile to load):
         - references/style.md
5. LLM 按步骤 1 → 调用 readPage(mode:'text')。
6. （可选）LLM 调用 readSkillFile 读取 style.md 校准语气。
7. LLM 输出最终 3 条 bullet 总结。
```

## MVP 内容

只发一个示例 skill，故意带一个参考文件验证多文件路径：

```
src/extension-skills/skills/summarizePage/
  SKILL.md
  references/style.md
```

单个示例足以证明：文件夹发现、frontmatter 解析、文件夹名一致性校验、
manifest 自动追加、两个工具通过 agentService 接入。加第 2 个 skill
应该是零代码改动。

## 测试

| 文件 | 层 | 覆盖什么 |
|---|---|---|
| `tests/agent-core/parseSkillMd.test.ts` | core | frontmatter 正常路径、必填缺失报错、body 完整保留、未知 key 收进 meta |
| `tests/agent-core/skillRegistry.test.ts` | core | register / get / list 顺序、重名抛错、addFile 按 key 索引 |
| `tests/agent-core/useSkillTool.test.ts` | core | description 自动包含已注册 skill、命中返 body+manifest、未知 skill 报错 |
| `tests/agent-core/readSkillFileTool.test.ts` | core | 命中 / unknown_path / unknown_skill |
| `tests/extension-skills/loader.test.ts` | wired | 用 fixture-style modules dict（不真跑 vite glob）验证 folder 分组、name 不一致抛错、缺 SKILL.md 抛错 |
| `tests/integration/agent.live.test.ts` | live | 加一条用例：加载 summarizePage skill，给一个合成的 readPage 桩结果，断言 LLM 调 useSkill 后跑通流程 |

集成测试沿用现有 `MYCLI_TEST_API_KEY` gate，默认 skip。stub `readPage`
让用例不依赖真浏览器。

## 前向兼容

延后的特性都有干净的接入点：

- **用户安装**：`SkillRegistry.register` 已经接受任意 `SkillDefinition`。
  将来安装器从 IndexedDB 读或从 URL 拉取，构造 `SkillDefinition` 调
  `register` 即可。运行时工具不用改。
- **代码型 skill**：sandbox 落地后，loader 多解析 `tools.js` 和
  `manifest.json`，`useSkill` 返回 body 仍然是入口；工具注册增加一个
  registry hook。
- **Tags / 分类**：扩展 `SkillDefinition.meta`（已经保留未知 frontmatter
  字段）；给 `SkillRegistry` 加 `list({ tag })` 过滤。当 skill 数量超过
  阈值时，`useSkill` description 切到分类布局。

## 待观察问题

1. **skill body 长度**：太大的 body 吃上下文。`parseSkillMd` 是否在
   超过阈值（约 2000 token）时给作者警告（不强制）？延后到第 2 个
   skill 出来摸到真实上限再决定。
2. **`readSkillFile` description 体积**：30+ skill 且每个都有多个参考
   文件时，自动列出的可用路径会很长。MVP 可接受，等 skill 数量真起来
   再优化（如：useSkill 命中后才在 body 末尾局部列出本 skill 文件）。
3. **每轮 `tools` allowlist 的语义**：调用方传 `cmd.tools = ['readPage']`
   时，useSkill 默认就被排除。这是预期的 UX，还是 useSkill 应该总是
   包含？决策：严格按 allowlist——调用方需要 useSkill 就显式带上
   `'useSkill'`。

## 最终文件布局

```
src/agent-core/
  Skill.ts                    # SkillDefinition + parseSkillMd
  SkillRegistry.ts
  useSkillTool.ts
  readSkillFileTool.ts
  index.ts                    # 重新导出新增 symbol

src/extension-skills/
  skills/
    summarizePage/
      SKILL.md
      references/style.md
  index.ts                    # 唯一使用 import.meta.glob 的地方

src/extension/
  agentService.ts             # 把两个工具加进默认列表

tests/agent-core/
  parseSkillMd.test.ts
  skillRegistry.test.ts
  useSkillTool.test.ts
  readSkillFileTool.test.ts

tests/extension-skills/
  loader.test.ts

tests/integration/
  agent.live.test.ts          # +1 条 skill 流程用例
```
