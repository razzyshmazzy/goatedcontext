# Architecture

This document explains how `ctx` is put together and, importantly, *why* it is
shaped the way it is. The guiding principle:

> **The core product is the `ctx` CLI and context engine. Agent integrations
> (Claude Code today; Codex, Cursor, MCP tomorrow) are adapters around that core.**

## Core vs. adapters

```
             ┌─────────────────────────────────────────────┐
             │                  adapters                    │
             │   claude/       (codex/)   (cursor/)  (mcp/) │
             │      │             ·           ·         ·    │
             └──────┼───────────────────────────────────────┘
                    │  calls the CLI / engine, never storage
             ┌──────▼───────────────────────────────────────┐
             │                    core                       │
             │  preferences   retrieval   repos   environments│
             └──────┬───────────────────────────────────────┘
                    │  services own all domain logic
             ┌──────▼───────────────────────────────────────┐
             │                  storage                      │
             │   sqlite (metadata)      secrets (encrypted)  │
             └───────────────────────────────────────────────┘
```

- **`src/core/`** — the engine. Pure domain logic in small services:
  `PreferenceService`, `RetrievalEngine`, `RepoService`, `EnvironmentService`.
  `CtxContext` (`src/core/context.ts`) is the composition root that wires them to
  storage. Nothing here knows what an "agent" is.
- **`src/cli/`** — a thin Commander-based CLI that maps subcommands to service
  calls and formats output (human text, or JSON with `--json`).
- **`src/adapters/`** — integrations for specific agents. The Claude adapter
  writes SKILL.md files and a global-instructions block; the skills only *call the
  CLI*. No business logic is duplicated in an adapter.
- **`src/storage/`** — SQLite (with migrations) for metadata, and a `SecretStore`
  abstraction for secret values.

**Runtime.** ctx is developed and tested with Bun but published as a normal npm
package that runs on Node ≥ 22.13 (`npx goatedcontext setup`). The only
runtime-specific piece is SQLite: `storage/sqlite/driver.ts` exposes one tiny
synchronous interface and selects `bun:sqlite` under Bun or the built-in
`node:sqlite` under Node at open time (both loaded via `createRequire`, so neither
leaks into the other runtime's bundle). Because `node:sqlite` ships with Node, the
published package has **no native dependency** — no `node-gyp`, prebuilt binary, or
C++/Python toolchain. Any small behavioral difference between the two bindings
(parameter coercion, missing-row result, `run()` metadata) is normalized inside the
driver. Everything else uses `node:` APIs that work on both.

### Directory layout

```
src/
  cli/                 Commander CLI + output helpers
  core/
    preferences/       Preference & evidence model, similarity, service
    retrieval/         Retrieval pipeline + isolated precedence logic
    repos/             Git repo detection & stable identity
    environments/      Environment metadata + secret-injecting run
    context.ts         Composition root (owns db, config, secrets, services)
  storage/
    paths.ts           Resolves ~/.ctx (override with CTX_HOME)
    config.ts          config.json load/save (zod-validated)
    sqlite/            Database open + ordered migrations (driver.ts picks the backend)
    secrets/           SecretStore interface + encrypted-file backend
  adapters/
    claude/            Skills (source of truth) + idempotent installer
  utils/               ids, time, git, errors
skills/                Committed SKILL.md files, generated from the adapter
tests/                 Bun tests
```

## Storage model

Everything lives under `~/.ctx/` (overridable via `CTX_HOME`, which the test
suite uses for isolation):

- `~/.ctx/ctx.db` — SQLite database (metadata only).
- `~/.ctx/config.json` — user config.
- `~/.ctx/secrets/secrets.dpapi.json` — DPAPI-protected blobs (Windows default; **no key file**).
- `~/.ctx/secrets/secret.key` + `secrets.json` — AES key + ciphertext (encrypted-file fallback only).

### Schema

Migration **v1** created:

- **`repos`** — `id`, `identity` (unique), `name`, `remote_url`, `root_path`,
  `has_remote`, timestamps.
- **`preferences`** — `id`, `rule`, `normalized`, `category`, `scope`, `repo_id?`,
  `status`, `confidence`, `created_at`, `updated_at`, `last_used_at?`.
- **`evidence`** — `id`, `preference_id`, `source`, `repo_id?`, `evidence_text`,
  `created_at`.
- **`environments`** / **`environment_variables`** — the latter holds only a
  `var_name` and an opaque **`secret_ref`** (*never a value*).

Migration **v2** added the correctness/concurrency columns:

- `preferences.domain`, `preferences.polarity` — conflict detection & dedup.
- `preferences.version` — optimistic-concurrency compare-and-swap.
- `preferences.dedup_key` + a **partial unique index** (proposed/observed) —
  race-free proposal dedup.
- `evidence.agent_id`, `evidence.session_id` — provenance.
- `evidence.text_hash` + a **partial unique index** — atomic evidence dedup.

Migration **v4** added `preferences.applicability` (`relevant` | `always`,
defaulting existing rows to `relevant`) — see [Applicability](#applicability-relevant-vs-always).

Migrations are an ordered list in `src/storage/sqlite/migrations.ts`, tracked in a
`schema_migrations` table and applied inside `IMMEDIATE` transactions that re-check
the applied version — safe under concurrent first-run. Shipped migrations are never
edited — schema evolution means appending a new migration.

**Designed for future scope.** `scope` is a free `TEXT` column validated in the
app layer, so adding an `org`/`team` scope later only requires a new migration
that adds a nullable `org_id` column — no rewrite of existing rows or precedence
code that isn't already expecting it.

## Retrieval pipeline

`RetrievalEngine.retrieve()` (`src/core/retrieval/retrieval.ts`) is the central,
adapter-agnostic entry point. Given `{ cwd, task, limit, includeProposed }` it:

1. **Resolves the repo** for `cwd` (registering it on first sight).
2. **Gathers candidates** — all global preferences plus this repo's preferences,
   filtered to in-effect statuses (`locked`, `approved`) by default; proposals
   are included only when explicitly requested.
3. **Infers the task's domains** (package-manager, database, ui-framework, …) and
   its distinctive terms, after removing stopwords AND generic engineering verbs
   (`add`, `change`, `create`, `fix`, …) so filler words no longer drive matches.
4. **Scores each candidate** by strong signals — matching domain (0.5), matching
   category (0.2), IDF-weighted distinctive-term overlap (0.35), plus small
   repo/locked/approved bonuses — and **drops anything below a relevance
   threshold**. Weak incidental lexical overlap is not enough to be returned.
5. **Resolves conflicts by domain** (see below) and reports superseded rules in
   `overridden`.
6. **Trims to a concise set** — capped at 15 (default 12), sorted by relevance.
   There is **no forced minimum**: an unrelated task legitimately returns zero.
7. **Marks the returned preferences as used** (`last_used_at`, best-effort).
8. **Attaches environments** applicable to the repo, with an `available` flag but
   never any secret values.

Steps 2–6 run inside a **read transaction** (`BEGIN DEFERRED`) so retrieval sees a
single consistent snapshot, never a half-applied concurrent write. The result is
plain JSON, so any adapter — CLI, MCP, or another agent — consumes the same output.

## Applicability (`relevant` vs `always`)

Every preference has an **`applicability`** (column added in migration 4):

- **`relevant`** — the default and original behavior: injected only when it scores
  above the relevance threshold for the current task (steps 3–4 above).
- **`always`** — a universal behavioral directive (e.g. "Always respond in
  Italian.", "Never use emojis."): injected on **every** prompt, bypassing relevance
  scoring. This fixes the class of bug where a global always-on rule was filtered
  out for an unrelated prompt like "hi".

Applicability is set explicitly (`ctx remember --always …` / `--applicability
always|relevant`) or, when omitted, inferred conservatively by
`inferApplicability()` — it fires `always` only for an unmistakable **leading**
universal directive ("always …", "never …", "every time …", "for all tasks …",
"regardless of task …", "whenever you …") and never on soft words like
"prefer"/"should"/"usually" or hyphenated compounds like "always-on".

The retrieval pipeline splits candidates by applicability:

```
gather candidates (status + scope filtered)
  → always pool  : included wholesale, bypassing relevance scoring
  → relevant pool: scored against the task, dropped below threshold
  → combine → resolve conflicts / precedence → cap each pool → return
```

`always` rules bypass **relevance** only — they are still subject to status
filtering (a rejected always rule never appears), scope, precedence and conflict
resolution. Each pool has its own cap so neither can starve the other: `always` is
capped at **`MAX_ALWAYS = 20`** (chosen deterministically by precedence, then age,
then id, so the same prompt always yields the same set) and `relevant` keeps the
existing top-K limit (≤15, default 12).

`applicability` is stored as free TEXT and validated in the app layer, so a future
release can add **`conditional`** (a rule that applies when a structured condition
matches) by extending the enum and adding a nullable condition field or a small
side table — an additive, non-destructive migration. `conditional` is intentionally
**reserved for a later release** and not implemented here.

## Precedence

Conflict resolution is isolated in `src/core/retrieval/precedence.ts` as a pure,
exhaustively-tested function. Lower rank wins:

| Rank | Preference                       |
| ---- | -------------------------------- |
| 1    | locked **repo** preference       |
| 2    | approved **repo** preference     |
| 3    | locked **global** preference     |
| 4    | approved **global** preference   |
| 5    | proposed / observed              |
| ∞    | rejected (never eligible)        |

Because repo ranks sit above global ranks, **repo-specific instructions override
global developer defaults** — a core product requirement. Keeping this logic pure
and separate means it can be reused by any adapter and reasoned about in isolation.

**Conflict is decided by domain, not lexical similarity** (`resolveConflicts` in
`retrieval.ts`, also pure and unit-tested):

- **Exclusive domains** (`package-manager`, `database`, `ui-framework`,
  `state-management`) admit a single winner — the highest-precedence preference.
  This is why repo "must use npm" beats global "prefer pnpm" even though the two
  strings share no words.
- **Non-exclusive domains** (testing, architecture, error-handling, …) keep every
  preference except those addressing the same subject (same subject key, including
  direct contradictions), where precedence again decides.

## Analysis, similarity and polarity

`src/core/preferences/analysis.ts` extracts three deterministic signals from any
rule or task (no LLM, no embeddings):

- **Subject tokens** — the "what", with polarity markers and generic verbs
  removed, so "Use Redis" and "Never use Redis" share the same subject.
- **Polarity** — `positive | negative | neutral`, detected from directive words
  (`use/prefer/always` vs `avoid/never/do not/…`). Negation is **never** stripped.
- **Domain** — a coarse decision area from a small, extensible keyword catalogue.

`similarity.ts` wraps these in the `Similarity` interface (`JaccardSimilarity` over
subject tokens). This is the seam where semantic embeddings can later replace the
lexical implementation without changing callers.

**Proposal de-duplication** uses a canonical key of
`scope | repo | subjectKey | polarity`. Same key ⇒ merge evidence + recompute
confidence; different key ⇒ separate rule. Because polarity is part of the key,
contradictory proposals can never merge — the critical bug from the first dogfood.

## Secret isolation

Secret handling is a hard requirement, enforced structurally rather than by
convention:

- **Two separate stores.** SQLite holds metadata; secret values live behind the
  `SecretStore` interface (`src/storage/secrets/`). `environment_variables` rows
  hold only a `var_name` and an opaque `secret_ref`.
- **OS-native by default on Windows.** `createSecretStore` selects a backend and
  the choice is inspectable via `ctx status`:
  - **`windows-dpapi`** (default on Windows when available) protects values with
    the Windows Data Protection API (CurrentUser). **No encryption key is stored
    on disk** — the key is derived from the user's logon secret and managed by the
    OS. This removes the colocated-key weakness; blobs are useless on another
    account or machine. Implemented by shelling out to `ProtectedData` (no
    homemade crypto).
  - **`encrypted-file`** (fallback, and `CTX_SECRET_BACKEND=file`) uses AES-256-GCM
    with a key in a sibling file. It keeps plaintext out of SQLite but is **not**
    keychain-equivalent — `describe().secure` is `false` and `ctx status` prints a
    warning. macOS Keychain / libsecret backends can be added behind the same
    interface.
- **Atomic + locked writes.** Both backends write via temp-file + rename and
  serialize read-modify-write with an O_EXCL lock, so concurrent `env set` never
  truncates or loses data.
- **Injected, never printed.** `ctx env run` decrypts values into a *child-specific*
  environment object passed straight to the spawned process — it never mutates the
  parent `process.env`. `ctx` never echoes values; `ctx get` returns names only.
- **Swappable backend.** The interface is tiny and domain-free by design.

## Concurrency model

`ctx` is safe for many independent processes at once — several agents in one repo,
agents across different repos, or a mix of reads and writes. The design uses the
smallest locking that is correct; there is **no global ctx lock**.

**SQLite configuration** (`db.ts`). WAL journal mode (many concurrent readers + one
writer), `busy_timeout = 10s` (writers wait rather than fail), `synchronous =
NORMAL` (durable under WAL). The busy timeout is set *before* the WAL switch, and
the WAL switch itself is retried, because changing journal mode needs a brief
exclusive lock that predates the timeout being in effect.

**Transaction boundaries** (`sqlite/tx.ts`). All writes run in `withWriteTx`
(`BEGIN IMMEDIATE` + bounded retry): the write lock is taken up front, so a
`SELECT`-then-`INSERT` is atomic against every other writer. Reads that must be
consistent run in `withReadTx` (`BEGIN DEFERRED`). Transactions are short and never
wrap child processes or user prompts.

**Atomic multi-step operations.** `remember`, `propose`, `approve`, `reject`,
`forget`, and evidence writes are each a single transaction — a crash mid-write
leaves no half-written evidence or inconsistent preference.

**Proposal dedup race prevention.** `propose` runs find-or-create in one
`IMMEDIATE` transaction, so two agents proposing the same thing yield ONE
preference with TWO evidence rows, not a duplicate. A **partial unique index** on
`dedup_key` (for `proposed`/`observed`) is a hard backstop even if a second writer
slips through. Opposite-polarity proposals have different keys and stay separate.

**Evidence.** Identical evidence text (per preference) is collapsed atomically via a
partial unique index + `INSERT OR IGNORE`; distinct evidence always accumulates.
Confidence is **recomputed from the evidence count**, not incremented, so the value
is deterministic regardless of interleaving.

**Optimistic concurrency.** Every preference has a `version`. State transitions are
compare-and-swap (`UPDATE … WHERE id = ? AND version = ?`); if the row changed since
the caller read it, the write is refused with a `ConflictError` (exit 5) instead of
clobbering newer state. `--force` overrides intentionally. So a stale `reject` that
races a concurrent `approve` fails cleanly rather than silently losing the approve.

**Consistent reads.** `ctx get` reads inside `BEGIN DEFERRED`, so it observes state
either fully-before or fully-after any concurrent commit.

**Filesystem writes.** Config, secret stores, Claude `SKILL.md`, and `CLAUDE.md` all
use temp-file + atomic rename. Mutable-file read-modify-write cycles (secrets,
installer) run under short O_EXCL lock files (`utils/fs.ts`) with stale-lock
stealing — never held across child processes.

**Installer.** `ctx install claude` runs the whole install under a lock in the
Claude home and writes atomically, so simultaneous installs cannot duplicate the
instruction block, truncate `CLAUDE.md`, or leave a partial skill file.

**Crash recovery.** Because every DB mutation is a transaction and every file write
is atomic-rename, an interruption leaves the previous consistent state; the next
invocation either sees the prior state or the committed new one — never corruption.
Migrations re-check applied versions inside an `IMMEDIATE` transaction, so
simultaneous first-run `ctx init` processes never double-apply or partially migrate.

**Same repo vs different repos.** The repo record is an identity, not a session, so
any number of agents may use one repo concurrently. Different repos contend only on
the very short shared-store write transactions; ordinary reads never block.

## Why Claude is an adapter, not the core

Making any single agent the center of the architecture would be a trap:

- **Longevity.** Agents come and go; a developer's preferences and environments
  should outlive whichever tool is fashionable this quarter. Keeping the engine
  agent-independent means switching or adding agents costs an adapter, not a
  rewrite.
- **One source of truth.** If logic lived inside Claude skills, every new agent
  would re-implement (and diverge on) preference precedence, dedup, and secret
  handling. Instead, skills are thin shims that shell out to `ctx`, so all agents
  share identical behavior.
- **Testability & security.** Precedence, retrieval, and secret isolation are
  plain functions and services with direct unit tests — no agent runtime, no LLM,
  no network required to verify correctness.
- **Clean growth path.** The same `retrieve()` output that powers the CLI will
  power an MCP server or a Codex/Cursor adapter unchanged.

So Claude Code is served *first* and served *well* — via the `context`,
`context-learn`, and `context-env` skills and a global-instructions block — but
it plugs into the engine from the outside, exactly like every future adapter will.
