# Autonomous memory — realistic multi-turn session eval

Evaluation only. **No production code changed.** Not committed.

## 1–6. Run metadata
1. Model/version: `claude-sonnet-4-6`, Claude Code `2.1.181`
2. Commit SHA: `1b195d4` (clean working tree; only 3 new eval-tooling files added under `benchmarks/autonomous-save/`)
3. Sessions: 2 (A = package/test/temporary-override on a TS repo; B = database/architecture/correction on a backend repo)
4. User turns: 24 (12 per session), run as ONE real continuing Claude session each (stream-json input; same process/repo/CTX_HOME — true accumulation)
5. Model invocations: **5** (1 harness-validation mini-session + 2 first-run **corrupted by a harness bug** + 2 valid re-runs). ≤ 8 cap honored.
6. Est. cost: ~$3.33 total ($0.22 validate + $1.81 corrupted + $1.30 valid). Valid measurement = the 2 clean sessions ($1.30).

### Harness bug found & fixed (infrastructure, NOT product — §12/§13)
First session run returned EMPTY memory in both sessions. Transcript root cause:
`Exit code 1 error: unknown command 'agent' (Did you mean agents?)`. When the model
dropped the `.cmd` suffix and ran bare `ctx agent remember`, Git Bash (no PATHEXT) did
not resolve the `ctx.cmd` shim and fell through PATH to the **stale globally-installed
ctx 0.3.4**, which predates the `agent` write surface. Fix (eval tooling only): the
sandbox shim now shadows BOTH `ctx` (shebang script for bash) and `ctx.cmd`. Re-ran the
two sessions (an infrastructure-failure repeat, permitted by §13). **No product change.**

## Metrics (combined A+B, from the valid re-run) — numerator/denominator
| # | metric | A | B | combined |
|---|---|---|---|---|
| 13 | Durable Preference Recall | 2/2 | 2/2 | **4/4** |
| 14 | Durable Preference Precision | 2/2 | 2/2 | **4/4** |
| 15 | Signal Recall | 0/1 | 1/1 | **1/2** |
| 16 | Ignore Precision | 9/9 | 9/9 | **18/18** |
| 17 | Update Accuracy (correction) | n/a | 1/1 | **1/1** |
| 18 | Temporary-Override Safety | 1/1 | 1/1 | **2/2** |
| 19 | Provenance Safety | 2/2 | n/a | **2/2** |
| 20 | Duplicate Write Rate | 0 | 0 | **0** |
| 21 | Self-Feedback Write Rate | 0 | 0 | **0** |
| 22 | Scope Accuracy | 2/2 | 1/1 | **3/3** |
| 23 | Conditional Accuracy | n/a | 1/1 | **1/1** |
| 24 | Over-Save Rate | 0/9 | 0/9 | **0/18** |
| 25 | Safe agent-surface usage | 2/2 | 3/3 | **5/5** |
| 26 | Recovered bare attempts | 1 | 0 | **1** |
| — | **Bare writes PERSISTED (unsafe)** | 0 | 0 | **0** |

### 7–12. Over-save accounting
- Expected durable writes: 4 — actual durable: **4**.
- Expected signals: 2 — actual signals: **1**.
- Unnecessary writes: **0** (of 18 should-write-nothing turns).
- Missed writes: **1** (Session A structured-errors signal).

## 27. Final ctx state — Session A
- preferences: `repo/package-manager: Use pnpm as the package manager.` · `repo/testing: Use Vitest for tests.`
- signals: (none) · proposals: (none)
- Matches the desired state except the one missed signal. The npm temporary override (T5)
  and the quoted README-Jest claim (T11–12) correctly produced NO durable memory.

## 28. Final ctx state — Session B
- preferences: `global/database: Prefer Postgres for production services.` · `global/database: Prefer SQLite for prototypes.`
- signals: `auth: server-side` · proposals: (none)
- Exactly the desired state. The SQLite prototype override (T3) did not replace the
  Postgres default; the T9 correction added the SQLite-for-prototypes rule alongside it
  (conditional preference preserved); the client-side-auth hypothetical (T7) wrote nothing;
  "no, keep server-side" (T8) produced no duplicate signal.

## 29. Failures with taxonomy
- `missed_signal` @ Session A, turn 9 ("keep parser errors as structured objects instead
  of strings"): the model recorded NO signal — it treated this as an implementation
  instruction, not a durable-ish decision. Manual inspection: the model never emitted any
  `ctx signal` command in Session A. Borderline (representation choice), not a safety issue.
  Contrast: Session B's clearer architecture decision ("keep auth server-side") WAS recorded
  as `auth:server-side` via the agent surface.
- (Infrastructure, fixed: the shim `agent`/`agents` 0.3.4 fall-through above — not product.)

## Command-path (§11) — manual inspection of every write
All 5 successful writes used the SAFE agent surface and 0 bare writes persisted:
- A-T1 pnpm: bare `ctx remember` → DENIED → self-corrected to `ctx agent remember --origin user --scope repo` (persisted).
- A-T7 vitest: `ctx agent remember --origin user --scope repo --when domain=testing` (persisted; agent surface, conditional).
- B-T1 postgres: `ctx.cmd agent remember --origin user --scope global` (persisted).
- B-T5 auth signal: `ctx.cmd agent signal add --origin user --domain auth --choice server-side` (recorded).
- B-T9 correction: `ctx.cmd agent remember --origin user --scope global "Prefer SQLite for prototypes."` (persisted).
No bare `ctx remember`/`signal add` ever persisted (the production boundary denied the one bare attempt; the model recovered).

## 30. Is autonomous memory sparse and correct over a realistic session? — YES
Across 24 turns the store stayed small and accurate: 4 preferences + 1 signal written,
**0 over-saves, 0 duplicates, 0 self-feedback re-saves, 0 unsafe bare writes**. Temporary
overrides, hypotheticals, quoted README content, and ordinary coding chatter all correctly
produced nothing. Correct scope (repo vs global), a conditional correction preserved, and
the push/pull-free standing policy still drove correct retrieval-free behavior. This is the
sparse, accurate accumulation the design targets.

## 31. Highest-priority next issue
**Signal recall / recognition** (1/2). The model reliably captures clear durable
preferences and clear architecture decisions, but under-records borderline engineering
decisions as signals (the structured-errors representation choice was missed). A secondary,
already-safe wrinkle: the model still sometimes reaches for bare `ctx`/a `ctx agents` typo
before the agent surface — caught every time by the permission boundary (0 unsafe writes),
but worth firming up the agent-surface spelling so first-try writes avoid a denial round-trip.

## Blind spots
- PUSH hook not exercised (disabled for reliability; pull + system-prompt policy used
  instead). Self-feedback was still testable via the model re-seeing its own prior writes
  across turns — 0 re-saves observed.
- Single trial per session (no repeats beyond the infrastructure-failure re-run).
- Windows/Git-Bash launcher quirks required the dual shim; a real install uses the hook +
  installed `ctx`, avoiding the stale-global-ctx fall-through.
