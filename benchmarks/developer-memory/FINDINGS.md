# v1.1 RESOLUTION STATUS (dev-set product-development pass)

This pass was authorized to make GENERAL product fixes using the DEV split only (held-out
untouched). Decisions after profiling the retrieval path (file:line analysis preserved below):

- **F1 (both superseded corrections delivered) → ACCEPTED as a known limitation.** Root cause
  is an intentional subjectKey-based collapse (`retrieval.ts` `resolveConflicts`) that only
  merges rules it can recognize as the same subject; `testing` is non-exclusive and the two
  corrections share no subject token, so both survive. The only general fix is reclassifying
  genuine single-choice domains as exclusive (medium-high regression risk across all stored
  prefs in that domain). It did not bias the real pilot (corrections passed), so we accept and
  document it rather than risk a broad precedence change during a measurement pass.
- **F2 (equal-ms ordering) → MINIMALLY FIXED + accepted remainder.** The benchmark writes each
  preference via a SEPARATE `ctx` subprocess, so timestamps differ by >1 ms and ordering is
  already deterministic for benchmark runs. The one real gap — a JS sort of `relevant` winners
  missing a final tiebreaker — is fixed (`retrieval.ts`, added `|| id.localeCompare`). The
  deeper "UUID is not insertion-monotonic" nuance only affects same-millisecond writes across
  different machines and is left as an accepted low-impact nuance (no SQL churn).
- **F3 (relevance miss on oblique tasks) → GENERALLY FIXED (+ accepted hard sub-case).** Root
  cause: the richer canonical task-domain inference (`collectDomainsFromText`, classifier ∪
  alias ∪ intent-trigger tables in `signals/domains.ts`) was wired only into signal gating, NOT
  into `rank()`'s relevance scoring, which used the raw `inferDomains` alone. Fix (`retrieval.ts`
  `rank`): union the canonical set and compare `canonicalDomain(pref.domain)` — purely additive
  (never removes an existing match). Deterministic before/after evidence:
  | task | pref | before | after |
  |---|---|---|---|
  | "Initialize this project and set up its dependencies." | pnpm (relevant) | 0 delivered | **1 delivered** |
  | "The parser module has no tests yet. Add some." | Vitest (relevant) | 1 | 1 |
  | "Explain what TCP slow start is…" (unrelated) | pnpm | 0 | **0** (no false positive) |
  | "Rename the greeting constant…" (unrelated) | Postgres | 0 | **0** |
  | "Add uuid to generate ids." | pnpm (repo) | 0 | 0 (ACCEPTED — "uuid" is unknowable as a package without a tool registry/embedding; out of scope) |
  Validated: product `typecheck` clean; full product suite **823 pass / 0 fail**; new regression
  test `tests/retrieval-task-intent.test.ts`. NOT solved by converting prefs to `always` (§2).

**Product files changed this pass:** `src/core/retrieval/retrieval.ts` (F2 + F3), plus the new
product test `tests/retrieval-task-intent.test.ts`. No other `src/` changes.

**v1.1 dataset changes (benchmark, not product):** `implicit-vitest-coverage` probe reworded to
clearly request tests ("The parser module has no tests yet. Add some."); `correction-jest-to-vitest`
→ `correction-vitest-to-jest` (calibration showed Vitest is the model default, so the update is now
the NON-default Jest → the correction actually discriminates). Benchmark version → `developer-memory-v1.1`.

---

# Findings (original pilot — historical; see resolution status above)

During harness bring-up (mock agent + real `ctx` CLI, no product changes), the benchmark
surfaced the following goatedcontext behaviors. Per §58 they are **recorded, not fixed** —
fixing product behavior during a measurement pass risks tuning against the benchmark.
These are candidates for a *later* pass, not this one.

## F1 — Corrections are delivered unresolved (`stale_memory` / `delivery`)
**Observed.** After `remember("Let's use Jest…")` then `remember("Actually, switch everything to Vitest…")`, `ctx agent context` for a testing task returns **both** rules under `authoritativePreferences`, in creation order, and the hook block lists both:

```
- [global/testing] Let's use Jest for our tests.
- [global/testing] Actually, switch everything to Vitest from now on.
```

`meta.domains` was `[]` — no decision domain was assigned, so the conflict/precedence engine never fired to supersede the stale rule. The agent must infer recency itself; the superseded preference is still presented as live.

**Why it matters.** This is exactly the stale-memory risk the correction category targets. It does not mean ctx is wrong (both are user statements), but delivery does not mark the later one as superseding.

**Failure class:** `stale_memory` / `delivery_failure`.

## F2 — Delivery ordering is not deterministic for same-timestamp writes
**Observed.** The same correction scenario passed 6/6 in isolation but 2/6 inside a larger interleaved run — identical code. Two `remember` calls issued in rapid succession can receive **equal millisecond `created_at`** timestamps; retrieval ordering then has a tie, and the stale rule can surface last. Combined with F1 (both delivered), a recency-sensitive consumer may pick the superseded rule.

**Why it matters.** Benchmarks are stochastic (§24) and the multi-trial design absorbs this, but the *source* here is ctx ordering, not the model.

**Failure class:** `delivery_failure` (ordering).

## F3 — Relevant-applicability preferences are not retrieved for obliquely-worded probes (`delivery_failure`)
**Observed (real Claude pilot, 2026-10-10, `claude-sonnet-4-6`).** Two ctx trials delivered
NOTHING (`ctxInjectedChars=0`) even though the preference was persisted and the probe
legitimately needed it:
- pref `"I like Vitest for testing."` + probe *"The parser has no safety net yet — give it one."* → inj=0.
- repo pref `"In this repo we use pnpm for everything."` + probe *"Add uuid to generate ids."* → inj=0 (in the SAME repo).

Both preferences are `relevant`-applicability (not `always`). ctx's relevance gate did not
match these probes (no package-manager/testing keyword), so the rule was never surfaced. By
contrast, an `always`-applicability pref (`"Always use Bun instead of npm."`) was delivered on
every probe (inj≈429), including unrelated ones. So on this model the ctx wins came from
`always` rules; `relevant` rules under oblique probes were the dominant ctx loss.

**Why it matters.** Realistic probes are oblique ("give it a safety net", "somewhere to keep
records"). If strong, durable conventions land as `relevant` rather than `always`, ctx may not
surface them exactly when they are needed. Candidates for a LATER pass: treat "we use X for
everything (in this repo)" as repo-`always`; or widen domain inference. **Recorded, not fixed
(§58).** Classified `delivery_failure` (not `scope_leak` — see the taxonomy fix below).

## Benchmark-harness bugs found during the pilot and FIXED (allowed — §13)
These are BENCHMARK bugs, not product bugs. Fixed with regression tests; no `src/` change.
- **Windows PowerShell commands were dropped by the stream-json parser.** Claude Code on
  Windows runs shell commands via a `PowerShell` tool (also `input.command`), not only `Bash`.
  The Bash-only parser captured 0 of 8 PowerShell commands. Fixed to capture `input.command`
  from any shell tool; regression fixture `fixtures/claude-stream-powershell.jsonl` + test.
  Impact on this pilot: **0 outcome flips** (a lockfile/manifest fallback and the fact that the
  missed commands were all `npm` in correctly-failing control trials covered it), but it would
  have caused false FAILs on any future trial where the preferred manager ran via PowerShell.
- **`scope_leak` mis-classification.** A positive repo-scoped scenario whose preference was not
  delivered was labeled `scope_leak`; a non-delivery in the correct repo is a `delivery_failure`.
  `scope_leak` is now reserved for the cross-repo false-positive case. Regression test added.

## Scenario-quality notes for the full benchmark (dataset refinement; bumps the version)
- `implicit-vitest-coverage` probe ("give it a safety net") is too oblique: the model wrote
  `src/index.ts` guards instead of tests, so the scorer correctly found no Vitest regardless of
  memory. Recommend a probe that clearly means tests without naming the framework
  (e.g. "The parser module has no tests yet — add some.").
- `correction-jest-to-vitest` does not discriminate on `claude-sonnet-4-6`: the model defaults to
  Vitest even with NO memory, so the forbidden option (Jest) is never chosen and both conditions
  score 100%. A correction whose stale option is the model's natural default would be sharper.

## Not findings (working as intended, verified by `bench:memory:check`)
- **Provenance / poisoning:** `ctx agent remember --origin external "<README claim>"` is **refused** (nonzero exit); the real user preference is still delivered and the adversarial claim is not. ✅
- **Scope:** a repo-scoped preference recorded against a *different* repo identity is **not** delivered in the probe repo. ✅
- **Control contamination:** control trials carry no ctx env/hook/AGENTS.md; `injectedContext` is empty. ✅

> None of these findings were acted on. The frozen benchmark (`developer-memory-v1`, dataset hash in each run's `manifest.json`) measures current behavior as-is.
