# goatedcontext

[![CI](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml/badge.svg)](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml)

> “You know what’s funny? GOATS!” — Goat Simulator

Persistent developer context for coding agents.

Your coding style, architecture preferences, repo rules, and development conventions follow you across repositories and across Claude Code, Codex, and Cursor. Agents read the relevant context automatically and can remember durable preferences for you.

Totally local.

## Install

```bash
npx goatedcontext setup
```

Requires Node 22.13+.

`setup` installs or upgrades the persistent `ctx` CLI, detects supported coding agents, and repairs their goatedcontext integrations. It is safe to rerun whenever you upgrade or something breaks.

You never need to `npm install -g` manually.

Check everything with:

```bash
ctx --version
ctx agents
ctx doctor
```

## Just talk normally

You do not need to manually operate the memory CLI during normal coding.

Tell your agent:

> Always use Bun in this repo.

Claude Code, Codex, or Cursor can recognize that as a durable preference and persist it through `ctx`.

Then later, in another session:

> Use npm for this one command.

That is treated as a one-off instruction and is not stored.

Or:

> Actually use npm in this repo from now on.

The agent can update the durable preference for you.

Explicit durable preferences are remembered. Weakly inferred preferences are proposed instead. One-off task instructions are ignored. Secrets are never stored as preferences.

goatedcontext can also learn recurring development choices across projects without treating every one-off instruction as permanent memory.

Preferences are defaults, not rigid commands: agents can make project-specific exceptions while preserving the underlying preference.

## How context reaches agents

goatedcontext uses two delivery layers.

**Runtime context**

Claude Code and Codex receive dynamic context at prompt time, including relevant and matching conditional preferences.

**Static repo context**

Repo-scoped, approved or locked, always-on rules are projected into a managed block in `AGENTS.md`.

That gives Codex, Cursor, and other `AGENTS.md`-aware tools a durable repo-level instruction surface.

```text
ctx store
  ├─ repo approved/locked always → AGENTS.md
  └─ global/relevant/conditional → runtime adapters where supported
```

Cursor currently has no reliable prompt-time context-injection mechanism, so its dynamic runtime context is unavailable. goatedcontext does not broaden dynamic preferences into static rules to fake parity.

`AGENTS.md` never becomes the source of truth. The flow is one-way:

```text
ctx → AGENTS.md
```

Handwritten content outside the managed block is preserved.

## Agent memory

`setup` also installs a native goatedcontext memory skill for supported agents.

That skill teaches the agent when to:

- remember an explicit durable preference
- propose an inferred preference
- ignore a one-off instruction
- forget or replace an old preference
- choose repo vs global scope
- use always, relevant, or conditional applicability
- never persist secrets

Choose Supabase in a few projects and goatedcontext can surface that pattern the next time your agent needs to pick a backend — as evidence, without turning it into an automatic rule.

Check installed integrations with:

```powershell
ctx agents
```

Typical output:

```text
Claude Code   installed   runtime ✓   memory skill ✓
Codex         installed   runtime ✓   AGENTS.md ✓   memory skill ✓
Cursor        installed   runtime unavailable   AGENTS.md ✓   memory skill ✓
```

## Manual controls

The CLI is still available when you want explicit control or debugging.

```powershell
ctx prefs
ctx prefs pending
ctx prefs approve <id>

ctx remember --scope global "Prefer simple solutions over premature abstraction."
ctx remember --scope repo --always "Use Bun for development commands."
ctx remember --when language=typescript "Prefer strict TypeScript."

ctx conflicts
ctx history
ctx why <id>

ctx export
ctx import <file>

ctx sync
ctx agents
ctx doctor
ctx stats
```

Conditional preferences support deterministic conditions including:

```text
language=
file=
domain=
repo=
```

Repeat `--when` to combine conditions with AND.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full preference, precedence, conflict, delivery, and retrieval model.

## Agent management

```powershell
ctx install claude
ctx install codex
ctx install cursor

ctx repair claude
ctx repair codex
ctx repair cursor

ctx uninstall claude
ctx uninstall codex
ctx uninstall cursor
```

Install and repair operations preserve unrelated agent configuration.

`ctx setup` detects installed agents and converges their integrations automatically.

On Windows, Codex is configured so its normal workspace sandbox can access the local ctx store without requiring Full Access. Its memory skill also uses `ctx.cmd` to avoid PowerShell execution-policy issues with npm's `.ps1` shim.

## Debugging

```powershell
ctx doctor
ctx agents
ctx stats
ctx history
ctx conflicts
ctx test-hook --agent codex --task "..."
```

`ctx doctor` checks the local database, schema, Git integration, secret backend, agent integrations, memory skills, and relevant platform-specific configuration.

`ctx test-hook` lets you inspect retrieval and delivery without launching an agent.

## Retrieval

goatedcontext remains intentionally cache-free at the retrieval layer.

Eligible preferences are reduced in SQLite before semantic evaluation, while matching, conditions, conflicts, precedence, and delivery remain deterministic and immediately fresh across processes.

Effective `always` and matching conditional preferences are not silently discarded because an arbitrary count was exceeded.

## Secrets & environments

Reusable environment-variable bundles are kept separate from normal preferences.

On Windows, secret values use DPAPI.

Secrets are never returned through ordinary preference retrieval, runtime context injection, history, stats, or exports.

```powershell
ctx env add supabase-test
ctx env set supabase-test OPENAI_API_KEY
ctx env run supabase-test --exec bun test
```

In bash/zsh:

```bash
ctx env run supabase-test -- bun test
```

`ctx env set` reads the value from stdin so the secret does not need to appear in shell history.

## What it does

```text
you state a durable preference
          ↓
the coding agent recognizes it
          ↓
the agent writes it through ctx
          ↓
ctx becomes the local source of truth
          ↓
future agents receive the right context
```

Repo preferences can override global preferences. Explicit durable preferences may be remembered directly; inferred preferences are proposed conservatively.

## More

- [Architecture](./ARCHITECTURE.md)

## Development

Built with [Bun](https://bun.sh) and published as a normal npm package.

Development and tests use Bun. The published CLI runs on Node ≥ 22.13 using Node's built-in `node:sqlite`, with no native SQLite addon or compiler toolchain required.

```powershell
git clone https://github.com/razzyshmazzy/goatedcontext
cd goatedcontext
bun install
bun test
bun run typecheck
bun run build
```

For releases, see [RELEASE.md](./RELEASE.md).

## KonaGoat

![Konata Izumi as a goat](https://i.imgur.com/R99FYau.jpeg)