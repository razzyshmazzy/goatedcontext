# goatedcontext

[![CI](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml/badge.svg)](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml)

> “You know what’s funny? GOATS!” — Goat Simulator

Persistent developer preferences for Claude Code.

Your coding style, architecture preferences, repo rules, and dev environments follow you across repositories. Claude receives the relevant ones automatically before it starts working. Totally local.

## Install

```bash
npx goatedcontext setup
```

Restart Claude Code.

That's it.

```bash
ctx status
```

No repo to clone, no Bun, no manual steps. `setup` initializes your local context, installs the Claude Code adapter (skills + proactive hook), and leaves a persistent `ctx` command on your PATH. It's idempotent — run it again anytime to repair or verify.

## Try it

```powershell
ctx remember --scope global --category architecture "Prefer simple solutions over premature abstraction."
```

Then open any repo and use Claude normally.

Relevant preferences are injected automatically before Claude works. If nothing is relevant, nothing is injected.

## Useful

```powershell
ctx doctor
ctx status
ctx prefs
ctx prefs pending
ctx prefs approve <id>
ctx conflicts
ctx history
ctx why <id>
```

`ctx history` shows a compact, local, append-only log of recent changes (remembered, proposed, approved, rejected, locked/unlocked, forgotten, and environment add/remove) with provenance. Add `--repo`, `--limit <n>`, or `--json`. Secret values are never recorded.

`ctx export` writes a portable JSON bundle of your preferences, evidence, and repo links (never secrets) to stdout, or to a file with `--out`. `ctx import <file>` merges a bundle back in — idempotently, without duplicating rules or overwriting existing ones. Use `-` as the file to read from stdin.

`ctx install claude --repair` rewrites any missing or corrupted ctx files and restores the hook, leaving unrelated Claude config untouched. `ctx uninstall claude` removes only the ctx integration (skills, instruction block, hook) — your preferences and environments are kept.

`ctx conflicts` lists active preferences that compete for the same decision (e.g. two package managers, or a rule and its negation), shows which one wins during retrieval, and never auto-resolves. Add `--global`, `--repo`, or `--json`.

`ctx doctor` checks your install end to end (database, schema, Git, secret backend, Claude skills/hook, and whether `ctx` resolves on PATH) and prints a concrete fix for anything broken. Add `--json` for scripts.

`ctx test-hook --task "..."` dry-runs the proactive-retrieval hook for a task without launching Claude, so you can see exactly which preferences would be injected. Add `--json` for scripts.

## Secrets & environments

Reusable environment-variable bundles.

On Windows, secrets use DPAPI and no encryption key is stored on disk. Secrets are injected only into child processes and are never returned by normal `ctx` retrieval.

```powershell
ctx env add supabase-test
ctx env set supabase-test OPENAI_API_KEY
ctx env run supabase-test --exec bun test
```

In bash/zsh:

```bash
ctx env run supabase-test -- bun test
```

`ctx env set` reads the secret from stdin, so it does not need to appear in shell history.

## What it does

```text
you correct Claude
      ↓
ctx proposes a preference
      ↓
you approve it
      ↓
Claude remembers it across repos
```

Repo rules override global ones. Preferences are proposed, never silently made permanent. Secrets are never stored as preferences.

## More

- [Architecture](./ARCHITECTURE.md)

## Development

Built with [Bun](https://bun.sh); published as a normal npm package that runs on Node ≥ 20 (no Bun needed at runtime).

```powershell
git clone https://github.com/razzyshmazzy/goatedcontext
cd goatedcontext
bun install
bun test
bun run typecheck
bun run build   # bundles the Node CLI into dist/
bun link        # optional: use your local build as `ctx`
```

Releasing (maintainers): see [RELEASE.md](./RELEASE.md).

## KonaGoat

![Konata Izumi as a goat](https://i.imgur.com/R99FYau.jpeg)