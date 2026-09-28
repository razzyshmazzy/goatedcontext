# goatedcontext

> “You know what’s funny? GOATS!” — Goat Simulator

Persistent developer preferences for Claude Code.

Your coding style, architecture preferences, repo rules, and dev environments follow you across repositories. Claude receives the relevant ones automatically before it starts working. Totally local.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1.

```powershell
git clone https://github.com/razzyshmazzy/goatedcontext
cd goatedcontext
bun install
bun run build
bun link
ctx init
ctx install claude
```

Restart Claude Code.

`ctx` must be on your PATH because the Claude hook runs `ctx hook claude-prompt`. A standard Bun install puts `bun link` executables in `~/.bun/bin`.

Verify:

```powershell
ctx status
```

You should see:

```text
✓ skills installed
✓ global instructions installed
✓ proactive retrieval hook installed
```

## Try it

```powershell
ctx remember --scope global --category architecture "Prefer simple solutions over premature abstraction."
```

Then open any repo and use Claude normally.

Relevant preferences are injected automatically before Claude works. If nothing is relevant, nothing is injected.

## Useful

```powershell
ctx status
ctx prefs
ctx prefs pending
ctx prefs approve <id>
ctx why <id>
```

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

```powershell
bun test
bun run typecheck
```

## KonaGoat

![Konata Izumi as a goat](https://i.imgur.com/R99FYau.jpeg)