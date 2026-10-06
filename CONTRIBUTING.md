# Contributing

Thanks for looking. This is a small project; no CLA, no bureaucracy.

## Setup

```bash
git clone https://github.com/razzyshmazzy/goatedcontext
cd goatedcontext
bun install
```

Development and tests run on [Bun](https://bun.sh). The published CLI runs on Node ≥ 22.13 using Node's built-in `node:sqlite`, so there's no native addon or compiler toolchain.

## Before opening a PR

```bash
bun run typecheck
bun test
bun run build
```

All three must pass. CI runs the same on Linux, macOS, and Windows, plus the built CLI on plain Node. If you change behavior, add or update a test — the suite is the spec.

## Where things live

- `src/core/` — the engine (preferences, retrieval, signals, repos, environments). Domain logic lives here, in small services.
- `src/adapters/` — per-agent integration (Claude Code, Codex, Cursor). Thin; they call the core, never storage.
- `src/storage/` — SQLite + secrets.
- `src/cli/` — the `ctx` command surface.
- `tests/` — one file per area; `bun test <file>` to run one.
- `scripts/bench/` — the benchmark harness (`bun run bench`).

[ARCHITECTURE.md](./ARCHITECTURE.md) explains how the pieces fit and why. Read it before a non-trivial change — a lot of the design (atomic writes, cross-process locking, deterministic retrieval, the preference/proposal/signal split) is deliberate.

## Scope

Bug fixes and small, focused improvements are welcome. For anything large (a new agent adapter, a storage change, a new memory concept), open an issue first so we can talk about the design before you write it.
