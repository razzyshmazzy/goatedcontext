# `ctx` Dogfood Report v2 — Correctness & Concurrency Hardening

This report compares the **v0.1.0** build (first dogfood, `DOGFOOD_REPORT.md`) with
the hardened **v0.1.1** build. Every result below is observed by running the real
CLI and the real (multi-process) test suite, not read from source.

---

## Executive summary

**Verdict: ready for limited external alpha (on Windows), with documented caveats.**

The four headline problems from the first dogfood are fixed and covered by
regression tests:

- **Contradictory proposals can no longer merge.** Polarity is a first-class signal
  and part of the dedup key, so "Use Redis" and "Never use Redis" are always two
  distinct rules — verified both single-process and in a real concurrent race.
- **Retrieval is now selective.** `ctx get` infers task domains, strips generic
  verbs, scores by domain/category/distinctive-term overlap, and applies a relevance
  threshold. A button-color task returns **zero** database rules instead of twelve.
- **Semantic conflicts resolve correctly.** Conflict is decided by decision domain,
  not wording, so repo "must use npm" overrides global "prefer pnpm".
- **Every write is validated.** Invalid scope, empty/whitespace rules, unknown
  domains, and invalid environment names are rejected with clear errors and non-zero
  exit codes; nothing is persisted.

On top of that, the build was hardened for **multiple concurrent agents/processes**:
WAL + busy-timeout SQLite, `IMMEDIATE`/`DEFERRED` transaction boundaries, race-free
proposal dedup (transaction + partial unique index), atomic evidence dedup,
optimistic-concurrency version checks on state changes, consistent-snapshot reads,
atomic file writes with lock files for the secret store and Claude installer, and a
concurrency-safe migration runner. A dedicated suite spawns **real separate `ctx`
processes** sharing one `CTX_HOME` and proves no lost writes, no duplicates, no
corruption, and no deadlocks.

The biggest security weakness — the colocated encryption key — is resolved on
Windows: the default backend is now **Windows DPAPI**, which stores **no key on
disk**. The encrypted-file backend remains as a clearly-labelled, insecure fallback
for other platforms.

What still holds it back from a broad launch: retrieval/conflict logic is
deterministic and lexical (no embeddings), so paraphrases with no shared keyword or
domain can be missed; and native secret backends for macOS/Linux are not yet built
(those platforms use the file fallback).

**Automated tests:** 70 pass / 0 fail across 12 files (was 43). `bun run typecheck`
exits 0. The concurrency suite was run repeatedly and is stable (not flaky).

---

## Test environment

| Item | Value |
|------|-------|
| OS | Microsoft Windows 11 Home, 10.0.26200 |
| Runtime | Bun 1.4.2, Node v24.14.0 |
| Base commit | `ab5123c` (v0.1.0); v0.1.1 changes are on disk, uncommitted |
| Version | `ctx 0.1.1` |
| Secret backend observed | `windows-dpapi` (auto) — `secure: true` |
| Perf dataset | 200 preferences / 1000 evidence rows |

---

## Original bug regression table

| ID | Previous behavior (v0.1.0) | New behavior (v0.1.1) | Status | Regression test |
|----|----------------------------|-----------------------|--------|-----------------|
| BUG-1 | "Never use Redis" **merged** into "Use Redis" and raised its confidence | Two distinct proposals (`positive` / `negative`); evidence stays attached to the correct rule | **Fixed** | `preferences.test.ts` "CONTRADICTORY proposals never merge"; `concurrency.test.ts` "concurrent contradictory proposals" |
| BUG-2 | `ctx get` returned ~12 prefs for **every** task incl. irrelevant | Relevance threshold + domain scoring; button-color task returns **0** database prefs; unrelated task returns 0 | **Fixed** | `retrieval.test.ts` "UI task does NOT return database", "unrelated task…zero" |
| BUG-3 | global "pnpm" outranked repo "npm"; conflict undetected | Domain-based conflict; repo npm wins, pnpm in `overridden` | **Fixed** | `conflict-resolution.test.ts`; `retrieval.test.ts` "repo package-manager rule overrides" |
| BUG-4 | "Add …" tasks ranked "…adding…" rules #1 (filler-token noise) | Generic verbs stripped; IDF-weighted overlap; no spurious matches (task returns 0 when nothing relevant) | **Fixed** | `retrieval.test.ts`; reproduction below |
| BUG-5 | `--scope bogus` accepted & stored (unretrievable ghost) | Rejected via Zod, exit 2, nothing written | **Fixed** | `validation.test.ts` "unsupported scope" |
| BUG-6 | empty rule `""` accepted & stored | Rejected (empty/whitespace), nothing written | **Fixed** | `validation.test.ts` "empty/whitespace rule" |
| BUG-7 | 3 equivalent helper-fn corrections stayed as 3 proposals | Same-subject + same-polarity proposals now merge; genuinely different-subject paraphrases still separate (no embeddings) | **Partially fixed** (by design) | `preferences.test.ts` "similar same-polarity proposals merge" |
| BUG-8 | `ctx prefs \| head` dumped an EPIPE stack trace | Clean exit, no trace | **Fixed** | reproduction below (`output.ts` EPIPE guard) |
| BUG-9 | Windows `0600` on secret files not enforced (files 644) | Default backend (DPAPI) stores **no key file** at all; file fallback still can't enforce 0600 on Windows (documented) | **Fixed** for default; documented for fallback | manual + `status` |
| Friction | `ctx env run … -- …` broken in PowerShell | `--exec` separator works in PowerShell; `--` still works in bash | **Fixed** | reproduction below; `concurrency.test.ts` env race uses `--exec` |
| Security | encryption key colocated with data | DPAPI default: no on-disk key; recovery by copying files is impossible | **Fixed** on Windows | manual reproduction below |

---

## Retrieval quality — before vs after

Same query set as the first dogfood (payments-app repo, comparable seeded rules).
"Before" = v0.1.0 (returned ~12 prefs, tied at r≈0.25). "After" = v0.1.1 observed.

| Query | Before (v0.1.0) | After (v0.1.1) | Verdict |
|-------|-----------------|----------------|---------|
| Change the color of the settings button. | 12 prefs incl. PostgreSQL, payment-service | **0 prefs** (no DB/backend noise) | **pass** |
| Add formatting for transaction timestamps. | 12 prefs, #1 = spurious "root cause…adding" | **0 prefs** (no formatting rules seeded → nothing returned) | **pass** |
| Install a date formatting package. | "Check existing deps" #1 but padded with 11 others | dependency-policy rule returned; no padding | **pass** |
| Design settlement persistence. | DB rules buried at r=0.25 among 12 | database **and** architecture rules returned; UI rule excluded | **pass** |
| Which package manager to use…? (repo) | pnpm ranked above npm; both returned | repo "must use npm" (r≈0.9), pnpm **overridden** | **pass** |

Observed noise dropped from "≈12 results for everything" to "only genuinely related
rules, or none." Returning zero for an unrelated task is now intended behavior.

---

## Contradiction behavior

`ctx propose` on the hardened build:

```
propose "Use Redis."        -> Proposed (positive)
propose "Never use Redis."  -> Proposed (negative)   # separate rule, NOT merged
```

`ctx prefs` shows both, with polarity:

```
[proposed] (global/infrastructure) negative  Never use Redis.
[proposed] (global/infrastructure) positive  Use Redis.
```

Other cases (all kept distinct, verified in tests):

| Positive | Negative | Result |
|----------|----------|--------|
| Use Redis. | Never use Redis. | 2 rules |
| Prefer helper functions. | Avoid helper functions unless necessary. | 2 rules |
| Always use pnpm. | Do not use pnpm in this repository. | 2 rules |

Benign negation does not misfire: "Prefer non-blocking IO" is classified `positive`.

---

## Precedence behavior

Domain-based conflict resolution (pure `resolveConflicts`, unit-tested):

| Scenario | Winner | Correct? |
|----------|--------|----------|
| repo npm vs global pnpm (package-manager) | repo npm | ✅ |
| repo SQLite vs global PostgreSQL (database) | repo SQLite | ✅ |
| locked global vs approved repo | approved repo | ✅ (repo rank 2 < global rank 3) |
| locked repo vs locked global | locked repo | ✅ (rank 1) |
| rejected preference | never active | ✅ |
| two unrelated domains (database + testing) | both returned | ✅ |
| non-exclusive domain, distinct subjects | both returned | ✅ |
| non-exclusive domain, same subject opposite polarity | higher precedence wins | ✅ |

Live example (repo v2app): task "Which package manager to use when adding a
dependency?" → returns only `This repository must use npm.` (r=0.9), with
`overridden: ["Prefer pnpm for JavaScript projects."]`.

---

## Concurrency test results

Dedicated suite (`tests/concurrency.test.ts`) spawns **real separate `ctx`
processes** sharing one `CTX_HOME`, with per-test timeouts. Run repeatedly; stable.

| Scenario | Setup | Result |
|----------|-------|--------|
| **Init race** | 6 simultaneous `ctx init` on a fresh home | all exit 0; migration v2 applied **exactly once**; DB valid |
| **Concurrent equivalent proposals** | 8 processes propose the same rule, distinct evidence | **1** preference, **8** evidence rows — no duplicate, no lost evidence |
| **Concurrent contradictory proposals** | `Use Redis` ‖ `Never use Redis` | **2** rules (`positive`, `negative`), evidence attached correctly |
| **Installer race** | 5 simultaneous `ctx install claude` | exactly **1** instruction block; 3 skills present; no truncation |
| **Environment race** | concurrent `ctx env run env-a` ‖ `env-b`, different secrets | each child sees only its own var; **no cross-leak**; parent never printed secrets |
| **Lifecycle race** | simultaneous `approve` ‖ `reject` of one pref | deterministic: `version == 1 + successes`; losers exit **5** (ConflictError), never a crash or lost update |
| **Different repos** | `ctx get` in repo A ‖ repo-scoped `propose` in repo B | both succeed; B's rule attached to B only (A has 0) |

Findings across all scenarios:

- **Writes lost:** none.
- **Duplicates:** none (proposal dedup held under the race; the partial unique index
  is a hard backstop).
- **Corruption:** none (WAL + atomic transactions + atomic file renames).
- **Deadlocks:** none (busy-timeout + short transactions; tests use timeouts that
  would fail visibly).
- **Stale writes silently overwriting newer state:** none — optimistic-concurrency
  refuses stale transitions with exit 5.

One real bug was found **and fixed** during this work: concurrent `ctx init`
intermittently failed with "database is locked" because `PRAGMA journal_mode=WAL`
was executed before `busy_timeout` was set (and the WAL switch needs a brief
exclusive lock). Fixed by setting `busy_timeout` first, making the WAL switch
tolerant/retrying, and running migrations through the retrying write-transaction
helper. After the fix, 6× loops of 8 concurrent inits showed 0 failures, and the
suite is stable across repeated runs.

---

## Security

- **Active backend (default, Windows):** `windows-dpapi`. `ctx status` reports
  `secure: true`. Verified round-trip via `ctx env set` / `ctx env run`.
- **What it protects:** values are DPAPI-protected (CurrentUser). **No encryption
  key is stored on disk** — only `secrets.dpapi.json` blobs, which are bound to the
  user account + machine. The v0.1.0 attack (read the secrets dir → recover
  everything) no longer works: there is no key to steal, and blobs are useless
  elsewhere. Confirmed no plaintext in the blob file and no `secret.key` present.
- **Colocated-key weakness:** **resolved** for the default Windows backend. It still
  exists in the `encrypted-file` **fallback** — which is exactly why `ctx status`
  labels that backend `secure: false` and prints a warning, and the docs never claim
  it is keychain-equivalent.
- **Concurrent secret writes:** atomic (temp-file + rename) and serialized by an
  O_EXCL lock; concurrent `env set` cannot truncate/corrupt the store (exercised by
  the env race test).
- **Windows permission limitation:** the intended `0600` mode is still not enforced
  by Windows for the fallback's files; this is moot for the DPAPI default (no key
  file) and documented for the fallback.
- **Unchanged guarantees (re-verified):** no secret value appears in `ctx get`,
  `ctx prefs`, `ctx env list/vars`, or SQLite; `ctx env run` injects into the child
  env only and never mutates the parent process env.

**Not tested:** DPAPI behavior across a Windows account password reset (OS-managed);
macOS/libsecret backends (not implemented).

---

## Performance

Dataset: 200 preferences / 1000 evidence. Times include full Bun/TS cold start
(~145 ms), which dominates.

| Operation | Observed |
|-----------|----------|
| Single `ctx get` (200 prefs) | ~150–173 ms |
| 10 concurrent `ctx get` | ~355 ms **wall clock** (reads run in parallel under WAL; not serialized) |
| 10 concurrent `ctx propose` | ~294 ms wall clock; writes serialize safely, no corruption |
| Retrieval algorithm cost | ~10–25 ms on top of cold start at this scale |

Reads do not serialize (10 concurrent gets finish in ~2× a single get, not ~10×).
Writes serialize on the SQLite write lock but each is short. No lock contention
symptoms observed. Note: with the DPAPI backend, `env set`/`env run` add ~100–200 ms
each for the PowerShell `ProtectedData` call — acceptable for infrequent secret ops.

---

## Remaining bugs

- **LOW — empty positional exit code.** `ctx remember … ""` is rejected by the arg
  parser as "missing required argument" (exit 1) rather than the validation path
  (exit 2). Still non-zero, clean, and nothing is written; whitespace-only rules do
  hit the exit-2 validation path.
- **LOW — `last_used_at` is best-effort.** Under heavy write contention the retrieval
  "last used" stamp may be skipped (by design, so reads never fail). Analytics-only.

No correctness, concurrency, or secret-isolation bugs remain open from testing.

## Remaining product friction (not bugs)

- **DPAPI secret ops are slower** (~100–200 ms) because each shells out to
  PowerShell. Fine for occasional `env set`; noticeable if a script sets many
  secrets in a loop. Batching could be added later.
- **`--exec` discoverability.** PowerShell users must know to use `--exec` instead of
  `--`. The error message and docs explain it, but it is an extra thing to learn.
- **Lexical domain/relevance.** Domains are keyword-driven; a task in a domain with
  no keyword match, or a rule with no domain and no shared distinctive term, can fall
  below the threshold and be omitted. This is the deliberate trade for "no noise" and
  is the main place embeddings would help later.
- **macOS/Linux fall back to the file backend** — secure storage there needs the
  planned Keychain/libsecret backends.

---

## External-alpha blockers

There are **no correctness or safety blockers** for a limited external alpha on
Windows:

- all critical/high bugs from v0.1.0 are fixed and regression-tested;
- multi-process concurrency is proven with real processes (no lost writes,
  duplicates, corruption, deadlocks, or stale overwrites);
- secrets use an OS-native backend with no on-disk key by default.

Conditions to attach to a limited alpha (not blockers, but disclosures):

1. **Windows-first.** macOS/Linux users get the `encrypted-file` fallback until
   Keychain/libsecret backends land; `ctx status` tells them.
2. **Retrieval is deterministic/lexical.** Set expectations that paraphrased rules
   with no shared keyword/domain may not be matched; embeddings are on the roadmap.

A broad public launch is **not** yet justified — primarily the macOS/Linux secret
story and the lexical-retrieval ceiling — but a limited, Windows-focused external
alpha is supported by the evidence.
