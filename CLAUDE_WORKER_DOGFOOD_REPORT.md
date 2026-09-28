# ctx — Live Claude-Worker Dogfood Report

A live integration test of `ctx` driven by **real Claude Code worker processes**
(`claude -p`, headless), not simulated agents. Workers ran with an isolated
`CTX_HOME`, an isolated Claude config dir (with copied credentials), the installed
`ctx` skills + `CLAUDE.md` block, and a logging `ctx` shim that recorded every
invocation. All secrets used are fake.

---

## Environment

| Item | Value |
|------|-------|
| ctx version | 0.1.1 |
| Claude Code version | 2.1.181 |
| OS | Windows 11 (10.0.26200) |
| Commit | `020ae95` |
| Test CTX_HOME | `C:\Users\…\Temp\ctx-live\ctxhome` (+ `ctxhome-empty` control) |
| Claude config | `C:\Users\…\Temp\ctx-live\claude` via `CLAUDE_CONFIG_DIR` (credentials copied; skills + CLAUDE.md installed by `ctx install claude`) |
| Secret backend | `encrypted-file` (`CTX_SECRET_BACKEND=file`, for speed/determinism) |
| Orchestration | Separate real `claude -p --permission-mode bypassPermissions --output-format json` processes; concurrency via shell `&`/`wait`; a `ctx` shim logged timestamp/PID/cwd/session/args (secrets redacted) |

**Install verification (before workers):** 3 skills present (`context`,
`context-learn`, `context-env`), `CLAUDE.md` had exactly one `ctx:begin` block, 15
seed preferences loaded. A diagnostic worker confirmed it **loaded the CLAUDE.md ctx
instructions and saw all three skills** in its available-skills list — so the
harness delivers the product's guidance to the model correctly.

**Headline metrics**

- Real Claude workers launched: **25** task workers (+2 diagnostic probes)
- ctx `get` calls: **8** (2 autonomous on meaningful tasks; 6 instructed in stress)
- ctx `propose` calls: **6** (4 autonomous after corrections; 2 instructed in stress)
- ctx `env` calls: **2** (secrets worker)
- Concurrency failures: **0**
- Automatic-retrieval misses (meaningful tasks): **7 of ~9**
- Unnecessary retrievals (trivial tasks): **0**

---

## Worker matrix

| Worker | Repo | Task | Concurrent with | ctx get? | ctx propose? | Relevant ctx returned? | Behavior affected? | Result |
|--------|------|------|-----------------|----------|--------------|------------------------|--------------------|--------|
| WA | payments | add timestamp formatting | — | ❌ | — | n/a | used `toISOString`, no dep (aligned, but not via ctx) | ok |
| WB | mobile | add formatted date label | — | ❌ | — | n/a | native Intl, no dep (not via ctx) | ok |
| WDEP | payments | add date-parsing dependency | — | ✅ (`add a date parsing dependency…`) | — | yes (dep policy + npm) | **yes** — justified dep, offered native, used npm | ok |
| WE | payments | remember "use Redis…" | WF,WG,WH | — | ✅ (positive) | n/a | proposal created | ok |
| WF | payments | remember "never use Redis…" | WE,WG,WH | — | ✅ (negative) | n/a | separate proposal | ok |
| WG | mobile | remember "keep logic inline…" | WE,WF,WH | — | ✅ | n/a | proposal created | ok |
| WH | mobile | remember "avoid one-use helpers…" | WE,WF,WG | — | ✅ | n/a | separate proposal (not merged) | ok |
| WA3 | payments | persistence for payout records | WC,WD,WB3 | ❌ | — | n/a | mirrored PaymentService pattern (from code, not ctx) | ok |
| WC | payments | PaymentService.recordFailedAttempt | WA3,WD,WB3 | ❌ | — | n/a | extended PaymentService (from code) | ok |
| WD | payments | negative-amount validation | WA3,WC,WB3 | ❌ | — | n/a | added validation (from code) | ok |
| WB3 | mobile | local reduced-motion pref | WA3,WC,WD | ❌ | — | n/a | followed local-state pattern (from code) | ok |
| WOVRA | payments | add date dep + report manager | WOVRB | ✅ | — | yes (repo npm) | **yes** — cited repo rule, used **npm** (override) | ok |
| WOVRB | mobile | add date dep + report manager | WOVRA | ❌ | — | n/a | used **bun** (from package.json) — **missed** pnpm rule | ok |
| WSEC | payments | run tests in supabase-test env | — | (env) | — | env available | **yes** — used `ctx env run`, no secret leak | ok |
| WT1 | mobile | rename local variable | WT2 | ❌ (correct) | — | n/a | trivial edit | ok |
| WT2 | payments | fix comment typo | WT1 | ❌ (correct) | — | n/a | trivial edit | ok |
| WCTRL | payments (empty home) | add date dep | — | (empty) | — | none (control) | added dep **without justification** (contrast) | ok |
| S1 | payments | index for payment lookups | S2–S8 | ✅ | — | yes | code unfinished (max_turns) | exit 1 (max_turns) |
| S2 | payments | retry around recordPayment | S1,S3–S8 | ✅ | — | yes | done | ok |
| S3 | mobile | persist theme pref | S1,S2,S4–S8 | ✅ | — | yes | code unfinished (max_turns) | exit 1 (max_turns) |
| S4 | mobile | haptics toggle | others | ✅ | — | yes | done | ok |
| S5 | payments | currency-code validation | others | ✅ | — | yes | code unfinished (max_turns) | exit 1 (max_turns) |
| S6 | mobile | font-scaling pref | others | ✅ | — | yes | done | ok |
| S7 | payments | propose parameterized-SQL pref | others | — | ✅ (positive/database) | n/a | proposal created | ok |
| S8 | mobile | propose AsyncStorage-wrapper pref | others | — | ✅ (negative/architecture) | n/a | proposal created | ok |

The three `exit 1` stress workers failed with **`error_max_turns`** (an intentionally
low 8-turn cap in the harness), *after* their `ctx get` succeeded — not a ctx failure.

---

## Automatic retrieval

Meaningful engineering tasks with an autonomous opportunity to call `ctx get`
(excludes trivial, learning, secrets, instructed-stress, and the empty-home control):
**WA, WB, WDEP, WA3, WC, WD, WB3, WOVRA, WOVRB** → 9 tasks.

- **Auto-invoked `ctx get`: 2 / 9 (~22%)** — WDEP and WOVRA, *both* explicitly
  "add a dependency" tasks.
- **Missed: 7 / 9** — timestamp formatting, date label, payout persistence, a new
  service method, negative-amount validation, a UI preference, and (critically) the
  mobile dependency task WOVRB.

Trivial tasks (WT1 rename var, WT2 fix typo): **0 unnecessary `ctx get` calls.**

**Interpretation:** the trigger is *under*-active, not over-active. Claude reliably
calls `ctx get` only when the task literally reads as a dependency/package decision.
For architecture, data modeling, validation, and UI decisions — exactly the
categories the `context` skill enumerates — it usually skips ctx and works from the
code it can see. The instruction and skill are present and loaded; the model simply
does not treat them as mandatory in one-shot headless runs.

---

## Learning behavior

- **Corrections that caused proposals: 6 / 6.** Every worker told "remember/record
  this as a reusable preference" (WE, WF, WG, WH, S7, S8) invoked `ctx propose`. The
  `context-learn` skill triggers reliably on explicit preference statements.
- **Missed corrections: 0** among the explicit ones tested.
- **Proposal quality:** good — rules were normalized/generalized, marked `proposed`
  (never silently approved), evidence quoted the developer statement, no secrets.
- **Contradictions (T7):** "Use Redis" (positive/infrastructure) and "Never use
  Redis" (negative/infrastructure) were stored as **two distinct proposals with
  correct polarity, not merged** — including when the two workers ran concurrently.
- **Equivalents (T8):** "keep logic inline when a helper is called once" and "avoid
  extracting one-use helpers unless readability improves" were **NOT merged** (two
  proposals). Per the test's own guidance this is a **dedup limitation, not a bug**:
  the deterministic subject-Jaccard fell below threshold, made worse by Claude
  rephrasing each into a longer, differently-worded rule. Terse identical phrasing
  does merge (proven in the unit suite); verbose agent phrasing defeats it.
- **Provenance:** **0 / 22** evidence rows carry `agent_id`/`session_id`. Workers
  never passed `--agent-id/--session-id` because the skill doesn't instruct it. (The
  session id *was* captured in the test shim log, but it is not persisted in ctx.)

---

## Multi-agent behavior

### Different repos (WOVRA ‖ WOVRB; WA3/WC/WD ‖ WB3)
Both/all ran simultaneously, exit 0, no blocking. `ctx get` calls carried the correct
`--cwd`; a post-run spot check confirmed payments workers get payments repo rules
(PostgreSQL/npm/PaymentService) and mobile workers get mobile rules (pnpm/local-state)
with **no cross-repo leakage**.

### Same repo (WA3, WC, WD concurrent in payments)
Three workers edited `src/payment-service.ts` concurrently. This produced an ordinary
**two-agents-editing-the-same-file** interleave (WC noted the other's method was
present) — a Git/filesystem concern, **not** a ctx concern. None of them called ctx;
ctx state was untouched and uncorrupted. No repo was treated as exclusively owned.

### Concurrent learning (WE/WF/WG/WH; S7/S8)
6 concurrent `ctx propose` calls across two repos produced 6 correct proposals, **0
lost writes, 0 duplicate dedup-keys, 0 lock errors**. Contradictory pair stayed
separate; equivalent pair stayed separate (limitation above).

### Stress (8 workers)
8 concurrent workers → 6 `ctx get` + 2 `ctx propose` = 8 concurrent ctx calls.
**0 database-lock errors, 0 corruption, 0 duplicates.** Final `PRAGMA
integrity_check` = `ok`, 22 preferences, 6 proposals, 0 duplicate proposed dedup-keys.

**Explicit statements:**
- lock errors: **none**
- lost writes: **none** (every propose persisted; evidence counts correct)
- duplicate rules: **none** (0 duplicate dedup-keys)
- corrupted evidence: **none** (integrity ok)
- cross-repo leakage: **none**
- stale-state problems: **none observed** (no concurrent lifecycle transitions were
  driven by workers in this run; the CAS mechanism is covered by the unit suite)

---

## Behavioral impact

**Established (ctx demonstrably changed the output):**

- **WOVRA (repo override):** called `ctx get`, then wrote: *"the repository's stored
  convention … 'This repository uses npm.' — a repo-scoped, approved rule that
  overrides the global 'prefer pnpm' preference,"* and installed with **npm**
  (`package-lock.json`). Full chain — storage → retrieval → precedence → action —
  verified through a real agent.
- **WDEP:** called `ctx get`, then justified the dependency against the repo policy
  (*"requires justification and to prefer built-ins"*), offered a native `Date`
  alternative, and used npm. The **control (WCTRL, empty CTX_HOME)** given the same
  task simply added `date-fns` with no policy citation or alternative. The
  before/after contrast is concrete evidence that ctx preferences shaped the
  reasoning. Caveat: in both cases the dependency was still added because the task
  explicitly demanded one — ctx changed the *deliberation and package manager*, not
  the final add/no-add.
- **WSEC:** used `ctx env run supabase-test -- bun test` (the `context-env` skill),
  never handling raw credentials.

**No effect established (honest negatives):** WA, WB, WA3, WC, WD, WB3 produced
sensible, pattern-aligned code, but since they **did not call ctx**, their alignment
cannot be attributed to it — they read the existing code. WOVRB actively contradicted
the pnpm repo rule because it skipped retrieval.

---

## Secrets

- Claude **never requested raw secrets**, **never printed them**, **never stored them
  as preferences**.
- WSEC used `ctx env run` to inject `SUPABASE_URL`/`SUPABASE_ANON_KEY` into the child
  and stated no values were printed.
- A scan for the fake secret strings across **all worker logs, the ctx shim log, and
  `ctx.db`** found **zero** occurrences.

Secret handling under live agents is clean.

---

## Trigger quality

**Too weak.** Evidence: 2/9 meaningful tasks auto-invoked `ctx get`; 7 misses,
including a repo-override task (WOVRB) that then violated the repo rule. Trivial tasks
correctly triggered nothing (0/2), so it is not over-aggressive. The skill/CLAUDE.md
instruction is *advisory* and the model deprioritizes it for non-dependency
decisions. By contrast, `context-learn` (explicit "remember this") and `context-env`
(explicit environment task) triggered reliably — because the user phrasing maps
directly to those skills. The gap is specifically **proactive retrieval before
decisions the user didn't frame as "look this up."**

---

## Failures

| ID | Severity | Worker/Task | Reproduction | Expected | Actual | Likely cause |
|----|----------|-------------|--------------|----------|--------|--------------|
| F1 | **High** (integration) | WA, WB, WA3, WC, WD, WB3 | Give a meaningful non-dependency task to a fresh worker | `ctx get` before the decision | no ctx call | Advisory skill/memory instruction not treated as mandatory by the model in headless runs |
| F2 | **High** (integration) | WOVRB | Mobile "add a date dependency" | consult ctx → use pnpm (repo rule) | skipped ctx → used bun | Consequence of F1: no retrieval ⇒ precedence can't apply |
| F3 | Low | `ctx prefs pending --json` | run it | JSON | human text (flag ignored) | subcommand `--json` not honored |
| F4 | Low | all propose calls | inspect evidence rows | agent/session provenance | 0/22 populated | `context-learn` skill doesn't pass `--agent-id/--session-id` |
| F5 | Limitation (not a bug) | WG vs WH | two equivalent corrections | merge into one proposal | two proposals | deterministic subject-Jaccard < threshold; worsened by verbose agent phrasing |

**Not failures:** S1/S3/S5 `error_max_turns` (harness 8-turn cap); WC/WD same-file
edit interleave (ordinary concurrent-edit conflict, ctx uninvolved).

---

## Recommended changes

Ordered by observed impact on real Claude behavior.

1. **Make retrieval fire proactively — move it off model discretion (fixes F1/F2).**
   The single biggest gap: Claude skips `ctx get` on most meaningful decisions. A
   reliable fix is a Claude Code **hook** (e.g. `UserPromptSubmit` or a pre-decision
   hook) that runs `ctx get --cwd "$PWD" --task "<prompt>"` and injects the result as
   context automatically, so retrieval doesn't depend on the model choosing to call
   it. If staying skill-only, strengthen the `context` skill/CLAUDE.md wording from
   advisory to imperative, with concrete per-category trigger examples
   (architecture, data modeling, validation, package manager, infra) and a short
   "if you are about to write or change code that makes one of these choices, you
   MUST call ctx get first" rule.
2. **Have `context-learn` pass provenance (fixes F4).** Instruct workers to include
   `--agent-id`/`--session-id` (e.g. from `$CLAUDE_CODE_SESSION_ID`) so concurrent
   evidence is attributable — the whole point of the provenance columns.
3. **Fix `ctx prefs pending --json` (fixes F3).** Needed for any tooling/observability
   built on top of ctx.
4. **Reduce paraphrase-driven dedup misses (addresses F5).** Either have
   `context-learn` propose a *terse, normalized* rule (fewer clauses ⇒ higher subject
   overlap) or raise dedup recall. Optional/embeddings remain future work.
5. **Surface retrieved context back to the agent/output.** When `ctx get` returns
   rules, have the skill echo which rules it applied (or a hook that prepends them),
   so influence is observable and the agent is nudged to actually act on them —
   several workers that *did* retrieve only weakly reflected it.

---

## Final readiness

### Ready for continued private dogfooding.

**Why not limited external alpha yet:** the live test shows the **ctx engine is
robust under real concurrent Claude workers** — no lock errors, lost writes,
duplicates, corruption, or cross-repo leakage across 25 workers and up to 8
concurrent; secrets are never exposed; learning, contradiction-handling, and repo
override all work *when ctx is invoked*. **But automatic invocation is unreliable**
(~22% on meaningful tasks): Claude frequently doesn't call `ctx get` before decisions,
so in practice the product's core promise — the right context at the right time —
often doesn't reach the agent (WOVRB even violated a repo rule as a result). That is
an integration-layer gap, not an engine defect, and it is very likely fixable with a
hook-based trigger. Until proactive retrieval is reliable end-to-end with real
workers, keep it in private dogfooding.
