# Autonomous pull-based retrieval — v1.1 pass report

Status: implementation + deterministic validation complete; real-model pilot pending.
Branch: `freeze/developer-memory-v1.1`. **Not committed** (per instructions).

---

## 1. Current PUSH behavior (unchanged)

A `UserPromptSubmit` hook (`ctx hook claude-prompt`) runs on every message, calls the
retrieval engine (`track:false`, read-only), and injects a compact
`<ctx-developer-context>` block via `renderContextBlock`. Claude/Codex share the exact
same block. Cursor gets a `sessionStart` bootstrap + MCP. This path is untouched by
this pass — verified by the full suite and the "push path unchanged" regression test.

## 2. PULL architecture added

Hybrid, not a replacement. A new single source of truth —
`src/core/assets/retrieval-policy.ts` — defines WHEN an agent should proactively
retrieve, mirroring how `memory-protocol.ts` is the single source for WHEN to write.
It is consumed by every surface that teaches the boundary:

- Claude global `CLAUDE.md` standing block (`CTX_INSTRUCTION_BLOCK`)
- the Claude `context` skill (`Proactive retrieval (pull)` section)
- the MCP `get_context` tool description + MCP server instructions

All three pull transports (`ctx get`, `ctx agent context`, MCP `get_context`) are now
uniformly **read-only** (`track:false`) — `ctx get` was the only one still writing
(`markUsed`); fixed.

## 3. Standing instruction text (core, ~60 tokens)

> Persistent developer and project context — established preferences, conventions,
> prior technical choices, and known exceptions — is available through ctx, and
> relevant context is often injected for you automatically. Before a choice that could
> reasonably depend on how this developer or repository usually works, make sure you
> have that context: retrieve it when it was not already provided. Do not retrieve for
> requests that clearly do not depend on developer/project context.

Rendered with a concrete action (`ctx get …` for Claude), compact retrieve/skip
example sets, and a push/pull dedup clause ("if it was already injected this turn, use
it — do not re-fetch").

## 4. MCP `get_context` description

> Retrieve durable developer and project context relevant to the current decision —
> established preferences, conventions, prior technical choices, and contextual
> exceptions. Call this before a choice that could reasonably depend on how this
> developer or repository usually works (dependencies, testing, persistence,
> language/runtime, tooling, architecture), when that context was not already provided
> this turn. Do not call it for clearly unrelated factual or general questions.
> Read-only: it never saves or changes memory. …

## 5. Files changed / added

Changed:
- `src/core/assets/retrieval-policy.ts` **(new)** — canonical pull policy
- `src/adapters/claude/skills.ts` — standing block + `context` skill consume the policy
- `src/mcp/server.ts` — `get_context` description + server instructions from the policy
- `src/cli/index.ts` — `ctx get` now read-only (`track:false`)
- `skills/context/SKILL.md` — regenerated from the updated skill definition
- `package.json` — `bench:pull:*` scripts

Added (benchmark):
- `benchmarks/autonomous-pull/{scenarios,harness,score,cli}.ts`
- `benchmarks/autonomous-pull/tests/score.test.ts`
- `benchmarks/autonomous-pull/{tsconfig.json,README.md,REPORT.md}`

Added (regression tests):
- `tests/pull-retrieval.test.ts`

## 6. Tests added

- `tests/pull-retrieval.test.ts` (13) — standing instruction wording, MCP description
  (WHY present, no impl-detail leaks), read-only semantics (+ a control that bites),
  push path unchanged, compact-envelope instrumentation.
- `benchmarks/autonomous-pull/tests/score.test.ts` (16) — scenario schema, tool-call
  capture (CLI/MCP detection + `--task` extraction + stream parse), every metric and
  the full failure taxonomy, deterministic summary.

## 7. Product test results

- `bun run typecheck` → clean (root + `bench:pull:typecheck`)
- `bun test` → **862 pass / 0 fail / 7 skip** (131 files; +29 from this pass)
- `bun run smoke:mcp` → SMOKE PASS (get_context reflects the new description path)

## 8. Deterministic relevant cases (no model)

9/9 relevant scenarios retrieve the seeded preference (one per decision class):
dependency, testing, database, language/runtime, framework/tool, repo-convention,
architecture, conditional-convention, state-management.

## 9. Deterministic irrelevant cases (no model)

9/9 irrelevant scenarios return NOTHING (TCP slow start, HTTP 404, error summary,
Big-O, git rebase, mutex, greedy regex, SQL walkthrough, TCP vs UDP). Max response:
~110 tokens / 2 prefs (compact; respects budgets).

---

## 10–23. Real-model pilot

- **Model/agent:** `claude-sonnet-4-6`, Claude Code `2.1.181`, fresh isolated
  `CTX_HOME` + git sandbox per run, host hooks disabled (`--settings
  {disableAllHooks:true}`) so this measures PULL alone, and a PATH `ctx` shim routing
  to this working tree (the global install is a stale 0.3.4 that cannot read the 0.4.1
  store).
- **Real model calls:** 6 (3 relevant + 3 irrelevant, 1 trial each) — within the ≤10
  cap. **Reported cost: $0.52 total** (tasks ran in bypassPermissions, so the model
  did real exploration work; the knowledge questions were ~$0.03 each).

| metric | result |
|---|---|
| 11. Tool Recall | **2/3** (R-dependency ✓, R-database ✓, R-testing ✗) |
| 12. Tool Precision | **2/2** (every call was on a relevant task) |
| 13. Unnecessary Call Rate | **0/3** (no ctx call on any knowledge question) |
| 14. Retrieval Success After Call | **1/2** |
| 15. Adherence After Pull | **0/1** (inconclusive — see below) |
| 16. duplicate-call count | 0 |
| 17. no_call | 1 |
| 18. bad_query | 1 |
| 19. retrieval_miss | 0 |
| 20. adherence_failure | 1 (reclassified below) |
| infrastructure_error | 0 |

**Manual inspection of every call (spec §27):**

- `R-dependency` — **autonomously ran `ctx.cmd get`** with query `"add uuid package to
  new project"`. That diluted query did NOT retrieve the nanoid preference (the terse
  canonical probe `"Add uuid."` does) → **bad_query**. The model then stopped to ask
  which language/runtime the (empty) repo uses, so it never applied a dependency.
- `R-testing` — **did NOT call ctx** (no_call). It explored the empty repo looking for
  the "parser" to test, found nothing, and asked the user to paste the code. It got
  blocked on missing *code* before ever reaching a *framework* choice where a
  preference would matter.
- `R-database` — **autonomously ran `ctx.cmd get`** with query `"set up persistence for
  production"` → retrieved the Postgres preference (retr=true). It then explored the
  empty repo and asked the user what runtime/platform to target, so it never wrote the
  persistence layer. The `adherence_failure` flag is therefore **a false negative of
  the crude heuristic**: the model didn't *ignore* Postgres, it *stalled before
  applying it* on an underspecified empty repo.
- `N-tcp-slow-start`, `N-http-404`, `N-error-summary` — all answered directly, **0 ctx
  calls**. Correct abstention.

**21. Latency / context cost.** Per-trial wall-clock 3–41 s (dominated by the model
doing repo exploration, not ctx). ctx retrieval itself is a single sub-second CLI call.
Pull responses stay compact: deterministically ≤ ~110 tokens / ≤ 2 preferences.

**Confounds found (shape the next pilot):**
1. The sandbox repo was **empty** (`git init` only), so the models reasonably asked
   clarifying questions instead of acting — this makes Adherence/Retrieval-after-call
   hard to observe and caused the one no_call. A follow-up pilot should seed a minimal
   realistic repo (e.g. a `package.json` + a stub file) so tasks reach a real decision.
2. Models sometimes build a **diluted query** that retrieves worse than the terse probe
   (`"add uuid package to new project"` missed where `"Add uuid."` hits) — a query-
   quality issue the standing instruction could address ("send a short task phrase").

## 24. Remaining blind spots

- The relevance scorer is IDF-weighted subject-token overlap; terse tasks retrieve
  only when the seed rule shares the task's distinctive noun. Generic nouns like
  "script" are stripped, so a "write a quick script" task does NOT retrieve a Bun/
  scripting preference. This is a real F3-style gap, surfaced by the deterministic
  pass; worth a follow-up (domain/keyword expansion), but out of scope here.
- Pilot measures Claude only (headless-observable); Codex/Cursor wiring shares the
  same policy asset but is not benchmarked this pass.

## 25. Keep autonomous pull retrieval? — YES (promising)

With n=6 (so exact fractions, no fabricated percentages): the model called ctx on 2/3
relevant tasks, 2/2 of its calls were warranted, and it called on 0/3 irrelevant
tasks. That is exactly the discretion we wanted — it pulls when a dependency/database
decision is in play and stays silent on "explain TCP slow start / HTTP 404". The one
miss (R-testing) and the one bad_query are explained by the empty-repo confound and
query phrasing, not by the instruction over- or under-firing. Recommendation: **keep
the hybrid pull path**, then re-run a slightly larger pilot on seeded (non-empty) repos
and add a one-line "send a short task phrase" nudge to the standing instruction.

## 26. Next pass

Teaching Claude WHEN to SAVE memory (automatic capture/propose) — kept strictly
separate from this read-only pass.
