# ctx

**A persistent, local-first developer-context layer for AI coding agents.**

`ctx` remembers *your* engineering preferences — architecture, dependencies,
conventions, testing philosophy, hard do's and don'ts, lessons from past
corrections — and makes them available to any coding agent, in any repository,
without you re-teaching the same things over and over.

```text
   developer identity / preferences
                +
          repository context
                +
        secure environments
                ↓
           any coding agent
```

The MVP targets **Claude Code** first, but Claude is just an *adapter*. The core
is an agent-independent CLI and context engine designed so adapters for Codex,
Cursor, other SKILL.md-compatible agents, and MCP can be added later without
touching the engine.

---

## Table of contents

1. [What `ctx` is](#what-ctx-is)
2. [Why it exists](#why-it-exists)
3. [Installation](#installation)
4. [Five-minute quickstart](#five-minute-quickstart)
5. [The preference model](#the-preference-model)
6. [Environments](#environments)
7. [Claude Code integration](#claude-code-integration)
8. [Security model](#security-model)
9. [Current limitations](#current-limitations)
10. [Roadmap](#roadmap)

---

## What `ctx` is

`ctx` is a local CLI backed by SQLite that stores two kinds of things:

- **Preferences** — reusable engineering rules, scoped either globally (they
  follow you everywhere) or to a specific repository.
- **Environments** — reusable, named bundles of environment variables (including
  secrets) that you can inject into a command, e.g. `supabase-test`,
  `stripe-test`, `openai-dev`.

An agent asks `ctx get` for the *relevant* subset of your context for the current
repo and task, and gets back concise JSON. That's it. No cloud, no API key, no
LLM calls inside the core.

## Why it exists

Every time you start a new repo, you re-teach your coding agent the same things:
"prefer existing dependencies," "don't add another service layer," "we use
Vitest, not Jest," "never do X." That knowledge is trapped in individual chat
sessions or copy-pasted into per-repo instruction files.

`ctx` gives that knowledge a home that is:

- **persistent** across conversations and repositories,
- **local-first** — it's your data, on your machine,
- **reviewable** — nothing becomes a permanent rule behind your back, and
- **agent-independent** — one context layer, many agents.

## Installation

Requires [Bun](https://bun.sh) ≥ 1.1.

```bash
git clone <this-repo> ctx && cd ctx
bun install

# Run it directly:
bun run src/index.ts --help

# Or link it as a global `ctx` command:
bun link
ctx --help
```

## Five-minute quickstart

```bash
# 1. Initialize your local context home (~/.ctx).
ctx init

# 2. Teach ctx a global preference (takes effect immediately).
ctx remember \
  --scope global \
  --category dependencies \
  "Prefer existing dependencies before installing another package."

# 3. From inside any git repo, ask for relevant context for a task.
ctx get --cwd "$PWD" --task "Install a date formatting package"
```

`ctx get` is relevance-filtered: it returns only preferences that actually relate
to the task (matching domain, category, or distinctive terms), so an unrelated task
can legitimately return an empty list. It returns JSON like:

```json
{
  "repo": { "id": "…", "name": "drivesafe", "identity": "remote:github.com/you/drivesafe" },
  "task": "Install a date formatting package",
  "preferences": [
    {
      "id": "…",
      "rule": "Prefer existing dependencies before installing another package.",
      "category": "dependencies",
      "domain": "dependency-policy",
      "polarity": "positive",
      "scope": "global",
      "status": "approved",
      "confidence": 1,
      "relevance": 0.62
    }
  ],
  "environments": [
    { "name": "supabase-test", "scope": "global", "riskLevel": "test", "available": true, "variableNames": ["SUPABASE_URL", "SUPABASE_ANON_KEY"] }
  ],
  "overridden": []
}
```

Continue with environments:

```bash
# Create an environment and give it a secret (the value is never printed).
ctx env add test-api
ctx env set test-api OPENAI_API_KEY --value "sk-…"

# Run a command with the secret injected into the CHILD process only.
# bash/zsh:    use --
ctx env run test-api -- sh -c 'test -n "$OPENAI_API_KEY" && echo "key present"'
# PowerShell:  use --exec (PowerShell strips a bare --)
ctx env run test-api --exec npm test
```

Check health any time:

```bash
ctx status
```

Wire it into Claude Code:

```bash
ctx install claude
```

## The preference model

A **preference** is a single reusable rule:

| Field          | Meaning                                                        |
| -------------- | ------------------------------------------------------------- |
| `rule`         | The instruction, phrased generally.                          |
| `category`     | `architecture`, `dependencies`, `conventions`, `testing`, `security`, `infrastructure`, `data-modeling`, `general`, … |
| `scope`        | `global` (everywhere) or `repo` (one repository).            |
| `status`       | `observed` → `proposed` → `approved` → `locked` (or `rejected`). |
| `confidence`   | 0–1; explicit rules start at 1.0, proposals grow with evidence. |
| `last_used_at` | Updated whenever retrieval surfaces the rule.                |

Every preference carries **evidence** (source + text + timestamp) so you can
always answer "why is this a rule?"

### Two ways preferences are born

**Explicit — `ctx remember`.** A direct instruction from you. Becomes an
`approved` rule immediately (add `--lock` to make it `locked`).

```bash
ctx remember --scope global --category dependencies \
  "Prefer existing dependencies before installing another package."
```

**Inferred — `ctx propose`.** An agent noticed a possible reusable preference.
It becomes a `proposed` rule that **you review before it takes effect**. If a
similar proposal already exists, `ctx` attaches the new evidence and nudges its
confidence up instead of creating duplicates.

```bash
ctx propose --category architecture \
  --evidence "User rejected creation of another service layer." \
  "Prefer extending existing domain services before creating parallel service layers."
```

### Reviewing preferences

```bash
ctx prefs                 # list everything
ctx prefs pending         # proposals awaiting review, with evidence
ctx prefs approve <id>    # promote a proposal to approved
ctx prefs reject <id>     # decline (kept for audit, never retrieved)
ctx forget <id>           # delete permanently
ctx why <id>              # rule, scope, status, confidence, evidence, rationale
```

Ids can be given as a unique prefix (e.g. `ctx why 1264ab20`).

### Precedence

When rules conflict, `ctx` resolves them predictably. Higher wins:

1. **locked** repo preference
2. **approved** repo preference
3. **locked** global preference
4. **approved** global preference
5. **proposed / observed** (only surfaced with `--include-proposed`)

Conflicts are detected by **decision domain**, not by wording. Preferences carry a
domain (e.g. `package-manager`, `database`, `ui-framework`) inferred deterministically
(or set with `--domain`). In a single-choice domain, the highest-precedence rule
wins — so a repo rule "must use npm" overrides a global "prefer pnpm" even though the
two share no words. Repo-specific instructions therefore override your global
defaults, and `rejected` preferences are never returned.

Directive **polarity** is preserved: "Use Redis" and "Never use Redis" are treated as
opposite rules and never merged.

## Environments

Environments are reusable, named bundles of environment variables — separate
from preference memory. Metadata (names, scope, risk level, variable *names*)
lives in SQLite; secret **values** live only in the encrypted secret store.

```bash
ctx env add supabase-test --risk test
ctx env set supabase-test SUPABASE_URL      --value "https://…"
ctx env set supabase-test SUPABASE_ANON_KEY --from-env SUPABASE_ANON_KEY

ctx env list                       # names + availability, never values
ctx env vars supabase-test         # variable NAMES only
ctx env run supabase-test -- npm test        # bash/zsh
ctx env run supabase-test --exec npm test    # PowerShell (see note below)
ctx env remove supabase-test
```

Environments **compose** left-to-right (later wins on conflicts):

```bash
ctx env run supabase-test openai-dev -- npm test
```

> **Shell note:** put the command after `--` in bash/zsh. In **PowerShell**, a bare
> `--` is swallowed by the shell, so use `--exec` instead:
> `ctx env run supabase-test --exec npm test`. Multiple `ctx env run` invocations are
> safe to run concurrently — each child gets its own environment and secrets never
> leak between them.

Risk levels (`test` / `dev` / `prod`) are modelled today as advisory metadata so
that production environments can require explicit confirmation in a future
release.

## Claude Code integration

```bash
ctx install claude
```

This installs three global Claude Code skills that call the `ctx` CLI (they never
re-implement any logic):

- **`context`** — retrieve relevant preferences before consequential decisions
  (architecture, dependencies, data modeling, infrastructure, security, testing,
  significant implementation choices) via `ctx get`.
- **`context-learn`** — when you give a correction or express a reusable
  preference, propose it with `ctx propose`. Explicitly prohibits storing secrets.
- **`context-env`** — discover and run environments with `ctx env run`.

It also inserts a small, idempotent block into your global Claude instructions
(`~/.claude/CLAUDE.md`) between `<!-- ctx:begin -->` / `<!-- ctx:end -->`
markers. Running the installer again refreshes that block in place — it never
duplicates it and never touches your other instructions.

## Security model

Secrets are treated as radioactive. `ctx` **never**:

- stores secret values in SQLite,
- stores secret values in preference memory or evidence,
- prints secret values as CLI output,
- places secret values in SKILL.md files,
- exposes secret values through `ctx get`.

Secret **values** live only behind a `SecretStore` abstraction, selected
automatically and shown by `ctx status`:

- **Windows (default): `windows-dpapi`.** Values are protected with the Windows
  Data Protection API (CurrentUser). **No encryption key is stored on disk** — the
  key is managed by the OS and bound to your user account and machine, so copying
  the files to another account/machine yields nothing. This is the recommended,
  secure backend.
- **Fallback: `encrypted-file`.** AES-256-GCM with the key in a sibling
  `~/.ctx/secrets/secret.key`. It keeps plaintext out of SQLite but the key sits
  next to the data, so **anyone who can read the secrets directory can decrypt it**.
  `ctx status` flags this backend as insecure with a warning. Force it with
  `CTX_SECRET_BACKEND=file`.

`ctx env run` decrypts values into the **child process environment only** — it never
mutates the parent process env and never prints values. Secret writes are atomic
(temp-file + rename) and locked, so concurrent `env set` cannot corrupt the store.

> **Not yet keychain-equivalent on macOS/Linux.** There, `ctx` currently uses the
> `encrypted-file` fallback. Native macOS Keychain / libsecret backends can be added
> behind the same `SecretStore` interface without changing callers.

## Current limitations

- **Retrieval & conflict detection are deterministic/lexical, not semantic.**
  Domains, polarity, dedup and relevance use keyword/token strategies behind a
  `Similarity` interface, so embeddings can slot in later. Paraphrases that share no
  keywords and no domain may not be recognized as equivalent.
- **No-remote repos are identified by path.** Repos with an `origin` remote get
  a stable, move-proof identity; repos without a remote fall back to a hash of
  their root path and are treated as new if the directory moves.
- **OS keychain only on Windows (DPAPI).** macOS/Linux use the encrypted-file
  fallback for now.
- **Single machine, no sync.** There is no cloud or multi-device sync.
- **Claude Code is the only adapter** shipped so far.

## Concurrency

`ctx` is safe to run from many processes at once — several agents in one repo,
agents across different repos, or reads racing writes. It uses WAL-mode SQLite with
a busy timeout, short `IMMEDIATE`/`DEFERRED` transactions, atomic file writes, and
optimistic-concurrency version checks on preference state changes. There is no global
lock, so independent agents don't block each other. See
[ARCHITECTURE.md](./ARCHITECTURE.md#concurrency-model) for the full model.

## Roadmap

Not built yet, but the architecture deliberately leaves room for:

- an **MCP server** exposing the same context engine,
- **Codex** and **Cursor** adapters,
- native **macOS Keychain / libsecret** secret backends (Windows DPAPI ships today),
- **organization / team** preference scope,
- **cloud sync** and **encrypted multi-device sync**,
- **semantic retrieval / embeddings**,
- an optional **GUI**,
- **environment access policies** (prod confirmation) and an **audit trail**,
- **automatic confidence improvement** from repeated evidence.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit together and why
Claude is an adapter rather than the product core.

## Development

```bash
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
bun run scripts/gen-skills.ts   # regenerate committed skills/ from the adapter
```

## License

MIT — see [LICENSE](./LICENSE).
