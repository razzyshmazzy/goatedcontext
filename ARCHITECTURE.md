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
    sqlite/            Database open + ordered migrations
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
- `~/.ctx/secrets/secret.key` — 32-byte AES key (`0600`).
- `~/.ctx/secrets/secrets.json` — AES-256-GCM ciphertext (`0600`).

### Schema (migration v1)

- **`repos`** — `id`, `identity` (unique), `name`, `remote_url`, `root_path`,
  `has_remote`, timestamps.
- **`preferences`** — `id`, `rule`, `normalized` (similarity key), `category`,
  `scope`, `repo_id?`, `status`, `confidence`, `created_at`, `updated_at`,
  `last_used_at?`.
- **`evidence`** — `id`, `preference_id`, `source`, `repo_id?`, `evidence_text`,
  `created_at`.
- **`environments`** — `id`, `name`, `scope`, `repo_id?`, `risk_level`,
  `description?`, timestamps.
- **`environment_variables`** — `id`, `environment_id`, `var_name`,
  **`secret_ref`** (opaque pointer into the secret store — *never a value*),
  `created_at`.

Migrations are an ordered list in `src/storage/sqlite/migrations.ts`, tracked in a
`schema_migrations` table and applied transactionally. Shipped migrations are
never edited — schema evolution means appending a new migration.

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
3. **Ranks by relevance** to the task, blending lexical task/rule coverage with a
   small base weight from status and confidence (so authoritative rules aren't
   buried and zero-overlap rules still surface when there is room).
4. **Resolves conflicts** — among near-duplicate rules in the same category, the
   highest-precedence one is kept and the rest are reported in `overridden`.
5. **Trims to a concise set** — roughly 5–15 (default 12, hard-capped at 15). It
   deliberately does **not** return everything stored.
6. **Marks the returned preferences as used** (`last_used_at`).
7. **Attaches environments** applicable to the repo, with an `available` flag but
   never any secret values.

The result is plain JSON, so any adapter — CLI, MCP, or another agent — consumes
the exact same output.

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

## Similarity

`src/core/preferences/similarity.ts` defines a `Similarity` interface with a
deterministic, dependency-free `JaccardSimilarity` implementation (light
stemming + stopword removal + token-set Jaccard, plus a query-biased
`coverageScore` for ranking). It powers two things:

- **Proposal de-duplication** — `ctx propose` merges evidence into a
  sufficiently-similar existing proposal instead of spawning near-duplicates.
- **Retrieval relevance and conflict detection.**

No external embedding service is used in the MVP. The interface is the seam where
semantic embeddings can be added later without changing callers.

## Secret isolation

Secret handling is a hard requirement, enforced structurally rather than by
convention:

- **Two separate stores.** SQLite holds metadata; secret values live behind the
  `SecretStore` interface (`src/storage/secrets/`). `environment_variables` rows
  hold only a `var_name` and an opaque `secret_ref`.
- **Encrypted at rest.** The default `FileSecretStore` encrypts each value with
  AES-256-GCM using a key kept in a separate `0600` file.
- **Injected, never printed.** `ctx env run` decrypts values and passes them only
  into the spawned child process's environment. `ctx` itself never echoes them,
  and `ctx get` returns variable *names* and availability only.
- **Swappable backend.** The interface is intentionally tiny and domain-free so a
  hardware-backed OS-keychain backend can replace the file backend with zero
  changes to callers.

The current limitation (key co-located with data on the same machine) is
documented in the README's security section.

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
