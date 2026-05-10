# agent-kernel / eval

Internal evaluation harness for the agent kernel.

See `docs/superpowers/specs/2026-05-10-agent-eval-spec.md` for the design.

## Layout

- `core/`      — runner, scorer, trace consumer, types, reporters
- `fixtures/`  — fake tools + page snapshots
- `judges/`    — hard / trace-shape / llm-judge modules
- `tasks/`     — first batch of L1/L2/L3 tasks + builtinSuite
- `replay/`    — record/replay LLM client wrapper
- `cli/`       — `bun run eval` entry

## Usage from a kernel-consumer extension

Drop an `eval-config.ts` in your package root, then `bun run eval`. See `tasks/index.ts` for the bundled `builtinSuite`.
