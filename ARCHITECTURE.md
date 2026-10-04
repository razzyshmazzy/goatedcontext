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

Migration **v5** added `preferences.condition_json` (nullable `TEXT`, holding the
canonical JSON of a structured condition). It is purely additive: every existing
row keeps `condition_json = NULL`, so `relevant`/`always` behavior is byte-for-byte
unchanged, and the applicability enum gains `conditional` with no schema change
(applicability is free `TEXT`). See [Applicability](#applicability-relevant-vs-always).

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

## Applicability (`relevant` vs `always` vs `conditional`)

Every preference has an **`applicability`** that decides HOW it reaches the agent.
The three modes are deliberately distinct mechanisms — do not blur them:

```
relevant    = semantic retrieval          (scored against the task)
always      = unconditional runtime include (every prompt)
conditional = deterministic rule evaluation (0.2.8)
```

- **`relevant`** — the default and original behavior: injected only when it scores
  above the relevance threshold for the current task (steps 3–4 above).
- **`always`** — a universal behavioral directive (e.g. "Always respond in
  Italian.", "Never use emojis."): injected on **every** prompt, bypassing relevance
  scoring.
- **`conditional`** (migration 5) — injected only when a structured, deterministic
  **condition** evaluates true against the current runtime context. A conditional
  **never falls back to semantic relevance**: if its condition is false, or the
  context needed to decide it is unavailable, it simply does not apply.

Applicability is set explicitly (`--always` / `--when …` / `--applicability
always|relevant|conditional`) or, when omitted and no condition is given, inferred
conservatively by `inferApplicability()` — it fires `always` only for an
unmistakable **leading** universal directive and never on soft words like
"prefer"/"should"/"usually". A `--when` flag always implies `conditional`.

**Invariants** (enforced on every write path — remember/propose/import — by
`enforceConditionInvariant`): `relevant`/`always` ⇒ condition is `null`;
`conditional` ⇒ a valid condition is required. No silent coercion.

### The condition model

A condition is **pure data** — a serializable AST, never executable code, a shell
command, or an LLM prompt (`src/core/preferences/conditions.ts`, validated with
Zod):

```
Condition =
  | { language: string }   // a canonical language
  | { file: string }       // a forward-slash glob over the runtime's files
  | { domain: string }     // a known decision domain (reuses the classifier)
  | { repo: string }       // a canonical repo identity
  | { all: Condition[] }   // AND (non-empty)
  | { any: Condition[] }   // OR  (non-empty)
  | { not: Condition }     // NOT (one child)
```

Conditions serialize to **canonical JSON**: `all`/`any` members are sorted and leaf
values normalized, so two logically-equal conditions are byte-identical (no
duplicate on re-import merely from key/member ordering). `--when key=value` parses
one leaf (`language`/`file`/`domain`/`repo`); repeated `--when` flags AND together.
Values are never interpreted as expressions (`language=ts && domain=x` is a literal
value that fails validation, not a compound).

Supported leaves and their determinism rules:

- **language** — canonical set (typescript, javascript, python, rust, go, java, c,
  cpp, csharp, ruby, php, swift, kotlin, html, css, sql) with aliases (`ts`→
  typescript, `c++`→cpp, …). Inferred **only from file extensions**, never from
  task text ("add a type annotation" does not imply TypeScript).
- **file** — a glob (`**`, `*`, `?`) over repo-relative, forward-slash paths
  (Windows `\` normalized). A tiny built-in matcher (`src/utils/glob.ts`) — no new
  dependency.
- **domain** — reuses the existing deterministic domain classifier; the condition
  value must be a known domain.
- **repo** — compared against the existing canonical repo **identity** (not a raw
  path); friendly names are resolved to an identity at write time, failing rather
  than storing an ambiguous reference.

### Missing runtime context ⇒ no match

This is the central rule: **if the context required to decide a condition is
unavailable, the condition does not match.** No file known ⇒ file/language
conditions are false. No confident domain ⇒ domain conditions are false. Not in a
repo ⇒ repo conditions are false. The evaluator never guesses and never reaches out
to discover state — it reads only the adapter-constructed `RuntimeContext`.

### Runtime context + the evaluator

```
RuntimeContext { cwd, repo, task, files, languages, domain }
evaluate(condition, runtimeContext) -> { matched, reason, children? }
```

`buildRuntimeContext()` (the adapter's job) normalizes raw signals into this shape;
`evaluateCondition()` (`src/core/retrieval/evaluate.ts`) is a **pure, total
function** of `(condition, context)` with no I/O. Keeping construction and
evaluation separate is what lets different agent adapters feed the same evaluator
(see [universal-agent note](#note-preparing-for-universal-agent-support)).

### Retrieval pipeline with three pools

```
gather candidates (status + scope filtered)
  → always pool      : included wholesale, bypassing relevance
  → conditional pool : evaluate each condition; keep only matches
  → relevant pool    : scored against the task, dropped below threshold
  → combine → resolve conflicts / precedence → cap each pool → return
```

Matched conditionals are **not special-cased** in precedence or conflict
resolution — once a condition matches, the preference competes exactly like any
other (repo beats global, exclusive domains admit one winner, polarity/subject
conflicts resolve as usual). They remain subject to status (a rejected conditional
never appears; a proposed one only with `--include-proposed`), scope and locking.

Each pool has an **independent, deterministic cap** so none starves another:
`always` and matched `conditional` are each capped at **20** (`MAX_ALWAYS` /
`MAX_CONDITIONAL`, chosen by precedence, then age, then id), and `relevant` keeps
its top-K (≤15, default 12). Output order is always-on, then matched conditionals,
then task-relevant.

`ctx test-hook` is the debugging surface: it builds a (optionally explicit — `--file`,
`--language`, `--domain`) runtime context, lists matched preferences with the
reason each conditional matched, lists conditionals that did **not** match with
their failure reason, and (`--json`) emits the normalized runtime context plus the
full per-conditional evaluation trace.

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

## Note: preparing for universal-agent support

The conditional engine added in 0.2.8 is built with the next major stage —
**universal agent support** — in mind, without implementing any of it yet. The
layering is deliberately:

```
agent adapter            (Claude prompt hook today; Codex/Cursor/MCP later)
    ↓  constructs
normalized RuntimeContext { cwd, repo, task, files, languages, domain }
    ↓  fed into
conditional evaluator    (pure, agent-agnostic; src/core/retrieval/evaluate.ts)
    ↓
retrieval / conflicts / precedence
    ↓
formatted context
    ↓
adapter injection
```

The evaluator and condition AST live in **core** and contain **no Claude-specific
assumptions**. Claude is merely the adapter that happens to construct the
`RuntimeContext` today — and it does so from only what its hook payload provides
(`cwd` + prompt), which is why file/language conditions legitimately don't match
during a live Claude hook (the hook exposes no active file). A future adapter that
*can* report the active file, language, or workspace will populate the same
`RuntimeContext` fields and get identical, deterministic evaluation for free.

Explicitly out of scope for 0.2.8 (and delivered in 0.2.9 below): building those
other adapters and any `AGENTS.md` generation/syncing.

## Multi-agent adapters (0.2.9)

0.2.9 turns the seam above into working adapters for **Claude Code**, **OpenAI
Codex**, and **Cursor** — one shared core, thin agent-specific adapters. No adapter
has its own preference store, re-implements retrieval, or independently decides
precedence. The canonical result flows one way:

```
ctx store → normalized RuntimeContext → applicability (always/conditional/relevant)
          → retrieval + conflicts + precedence → canonical result
          → adapter { Claude | Codex | Cursor }
```

### Capabilities + the delivery planner (one policy, by ID)

Routing is NOT scattered through `if (agent === …)` checks. Each agent is described
by an explicit **capability set** (`src/core/agents/capabilities.ts`:
`runtimePromptInjection`, `staticAgentsMd`, `cwdAvailable`, `promptAvailable`,
`fileContextAvailable`, …), and one **pure planner** (`src/core/agents/delivery.ts`,
`planDelivery(capabilities, preferences)`) partitions preference **IDs** into
`static` / `runtime` / `unsupported` by a single policy:

```
repo + (approved|locked) + always   → static   (if the agent reads AGENTS.md)
                                      → runtime  (else, if it injects at runtime)
                                      → unsupported (else)
global always | any relevant | any conditional
                                      → runtime  (if it injects at runtime)
                                      → unsupported (else)   ← NEVER broadened to static
proposed | observed | rejected        → excluded from every bucket
```

An ID lands in exactly one bucket, so a preference is never delivered both ways to
one agent. The static materializer, the runtime-hook dedup, `ctx agents`, and
`ctx test-hook` all consume this one function, so policy can't drift between them.

Two delivery layers, each agent using what it natively supports:

- **A. Static interoperability layer** — `src/core/project/`. `AGENTS.md` is a
  static REPO projection, so it materializes **ONLY** the `static` bucket:
  `scope = repo`, `status ∈ {approved, locked}`, `applicability = always`. It
  deliberately does **not** contain global preferences (a personal always-rule must
  not land in a shared repo), `relevant` rules (writing them to a file must not make
  them unconditional), `conditional` rules (runtime-only), or
  proposed/rejected/evidence/secrets. It is a single marker-delimited managed block
  in the repo-root `AGENTS.md`, written by `ctx sync` (candidates are scoped to the
  repo first, so one repo's file can never contain another's rules).
- **B. Runtime injection layer** — the adapter hooks. The agent-neutral
  `renderContextBlock` (`src/core/render/context-block.ts`) is the single source of
  the `<ctx-developer-context>` block; Claude's and Codex's `UserPromptSubmit` hooks
  (`ctx hook claude-prompt` / `ctx hook codex-prompt`) both emit it byte-for-byte,
  giving task-relevant + conditional retrieval per prompt. The hook asks the planner
  for this agent's `static` IDs and **excludes them from the injected block**, so a
  rule Codex already gets from AGENTS.md is never injected twice.

### Compatibility matrix (verified against current docs)

| Agent | Static (A) | Runtime injection (B) |
| --- | --- | --- |
| **Claude Code** | — (delivered at runtime; its `CLAUDE.md` block is meta-instructions, not a preference projection) | ✅ `UserPromptSubmit` → `ctx hook claude-prompt` |
| **OpenAI Codex** | ✅ repo `AGENTS.md` (via `ctx sync`) — read into the first turn; `AGENTS.override.md` wins; 32 KiB `project_doc_max_bytes` | ✅ `UserPromptSubmit` via `~/.codex/hooks.json`; plain-stdout block |
| **Cursor** | ✅ repo `AGENTS.md` only | ❌ none reliable — `beforeSubmitPrompt` is block-only; `sessionStart.additional_context` is bugged |

**One canonical static path.** AGENTS.md alone gives Cursor the always-on baseline
(Cursor reads repo-root `AGENTS.md`), so 0.2.9 does **not** also write
`.cursor/rules/*.mdc` — that file would only add glob/`description`-scoped or
agent-requested targeting, which our always-on projection never uses, and
duplicating the same rules across two files is pure drift risk. A single AGENTS.md
block is the canonical static delivery for every AGENTS.md-aware agent.

**Codex is NOT double-served.** Codex reads AGENTS.md *and* runs a hook, so repo
approved/locked always rules go to AGENTS.md and are excluded from the Codex hook's
runtime block (planner `static` set); global always, relevant, and matching
conditional rules reach Codex at runtime. There is no global `~/.codex/AGENTS.md` —
global preferences are runtime, never materialized into a static file.

**Cursor parity is honest.** Cursor's hooks cannot inject model context today
(`beforeSubmitPrompt` returns only `{continue, user_message}`; `sessionStart`'s
`additional_context` is a staff-confirmed bug). goatedcontext serves Cursor through
the **static layer only**; `ctx agents` reports `runtime unavailable` and
`ctx test-hook --agent cursor` shows the static plan with no fabricated hook result.
Cursor therefore receives exactly the repo approved/locked always rules — global,
relevant, and conditional preferences remain **absent** rather than broadened into
always-on rules. If Cursor ships reliable `sessionStart` injection, a runtime Cursor
adapter can be added by flipping one capability, without touching core.

**Codex hooks caveat.** Codex lifecycle hooks are a new, fast-moving surface; the
docs describe the stdin/stdout contract but pin the `hooks.json` shape loosely
("mirrors Claude Code"). We use the Claude-shaped structure, keep the write additive
+ idempotent + reversible, and `ctx install codex` prints a note to verify against
the installed Codex version — while the static `AGENTS.md` channel applies regardless.

The condition evaluator, retrieval, conflicts, precedence, the context renderer, and
the delivery planner all remain in **core** with no agent-specific assumptions;
adapters translate native input → `RuntimeContext` and canonical plan → native
delivery, nothing more. `ctx agents` lists each adapter's capabilities and health;
`ctx doctor` diagnoses each independently; stats carry backward-compatible per-agent
counters (`hook_runs_by_agent`, `context_injections_by_agent`).

## Agents WRITE ctx too — the memory protocol (0.2.10)

Reading preferences is only half of persistent context. 0.2.10 teaches every
supported agent to WRITE durable preferences back, so a developer who says
"always use Bun in this repo" never has to run `ctx remember` by hand.

- **One canonical source.** The behavioral policy lives once, in
  `src/core/assets/memory-protocol.ts` (`MEMORY_PROTOCOL_BODY` + a version marker).
  It is instruction text, not a background process — there is no daemon, no extra
  LLM, no embeddings, no conversation scraping. The agent already understands
  language; the skill tells it WHEN to call the deterministic `ctx` commands.
- **Native skill surfaces, identical body.** It is installed through each host's
  own Agent-Skills (`SKILL.md`) surface — Claude's existing `context-learn` skill,
  Codex at `$CODEX_HOME/skills/goatedcontext/SKILL.md` (the `~/.agents/skills` path
  is newer; `$CODEX_HOME/skills` is still supported), and a **user** Cursor skill at
  `~/.cursor/skills/goatedcontext/SKILL.md` (Cursor's only file-based, all-projects
  mechanism; global rules are UI-only). Only the frontmatter wrapper differs; the
  body is byte-identical across all three (parity-tested).
- **The decision policy it teaches** (conservative by design):
  - *Explicit durable preference* ("always use Bun in this repo", "from now on use
    tabs") → `ctx remember`, silently. Scope: repo for "this repo/project/here",
    global only when clearly cross-project; **ambiguous → repo**. Applicability:
    `--always` for universal directives, `--when key=value` for explicit conditions,
    else the default `relevant`.
  - *Inferred* (a recurring pattern, not stated) → `ctx propose`, never `remember`;
    a single isolated request persists nothing.
  - *One-off task instruction* ("use Python for this script", "make this button
    red") → store **nothing**.
  - *Retraction* ("forget that I prefer Postgres", "actually use npm from now on")
    → look up (`ctx prefs`/`ctx why`) then `ctx forget`, or persist the replacement;
    if ambiguous, ask ONE clarification — never guess which memory to delete.
  - *Secrets / task data* → never preference-stored (those belong in `ctx env`).
  - Operate silently (don't narrate the CLI), and never fail or block the task if a
    write fails — mention it briefly only if an explicit preference couldn't persist.
- **Separation from AGENTS.md.** This is agent-level TOOLING — it is deliberately
  NOT placed in the repo `AGENTS.md`, which remains the static projection of repo
  approved/locked always preferences (the READ side). The skill teaches HOW to use
  ctx; ctx remains the source of WHAT the preferences are.
- **Lifecycle.** `ctx install <agent>`, `ctx repair <agent>`, and `ctx setup`
  (auto-detecting installed agents) all install/converge the memory skill; uninstall
  removes only the goatedcontext-owned skill directory, preserving unrelated skills.
  `ctx agents` and `ctx doctor` report each adapter's memory-skill health
  (`current`/`stale`/`missing`) via a version marker embedded in the installed file,
  so an out-of-date skill is flagged with a concrete repair command.
