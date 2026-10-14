# goatedcontext — Developer-Memory Benchmark (`developer-memory-v1`)

A reproducible benchmark that answers one question:

> **Does goatedcontext make coding agents retain and apply developer preferences better than their native context/memory alone?**

It measures **behavior, not recall.** The headline test is not "can the agent quote the preference" — it is: the user states a preference early, the agent does unrelated work (or the session ends), a later task implicitly needs that preference, and we check whether the agent *naturally does the preferred thing*.

```
user:  "Always use Bun instead of npm."
 … much later, after other work / a new session …
user:  "Add zod."

PASS:  bun add zod
FAIL:  npm install zod   (or yarn/pnpm, or asking which manager to use)
```

This is a benchmark **suite**, not a feature release. It changes **zero** goatedcontext product behavior and lives entirely outside `src/`.

---

## Thesis & what it does NOT measure

It measures **persistent developer-memory usefulness**: will the agent still make the developer's preferred choice when the user no longer repeats it? It deliberately does **not** measure raw LLM intelligence, context-window length, factual QA, or generic RAG quality.

## Experimental conditions (§2–3)

The workload after the preference is **identical** across conditions; only the delivery channel differs.

| Condition | How the preference reaches the agent |
|---|---|
| `control` | Ordinary conversation only. **No** goatedcontext (no hook, MCP, AGENTS.md, env, or memory). Verified ctx-free before every control trial (§33). |
| `ctx` | Persisted through ctx's real provenance-required write path (`ctx agent remember`) and delivered at probe time through ctx's real retrieval (`ctx hook` / `ctx agent context`). |
| `agentsmd` | The static `AGENTS.md` repo-instruction mechanism (comparison condition C). |

Native agent memory (condition D) is **not faked**: it is included only if an agent exposes a controllable, documented persistent-memory feature. None is wired in this version.

## Scoring: behavior-first & deterministic (§20–21)

Scorers read only **commands** and **files** — never the agent's prose. An agent that says *"I remembered you prefer Bun"* and then runs `npm install` **fails**. Scorer kinds: `commandContains`, `commandNotContains`, `fileExists`, `fileExtension`, `fileExtensionNotAnyOf`, `fileContains`, `packageAdded`, `frameworkDetected`, `exactChoice`, `noForbiddenChoice`, and `all`/`any` composites. All deterministic; no LLM judge in v1.

## Dataset (§5–§19)

34 hand-curated scenarios (dev=18 / heldout=16) across nine categories: explicit-default, repo-scoped, conditional (match **and** non-match), correction/reversal, implicit, negative/abstention, poisoning, conflict/precedence, reinforcement. Scenarios are declarative data (`scenarios/*.ts`), validated at load against anti-cheating rules (§5/§10): a probe may not ask for recall and may not leak the answer token. The dev/heldout split exists to make accidental overfitting obvious (§51); production ctx contains no scenario-specific logic.

> The brief targets 60–100 scenarios "quality over count". This v1 freezes a smaller, fully-validated set covering every category; the schema and category files are structured so the set can grow without touching the harness.

## Interference & depth sweep (§14–§15)

Standardized, preference-neutral coding workloads (`none`/`light`/`medium`/`heavy`) bury the preference under real agent work. `--sweep` runs all four levels to produce a retention-vs-interference curve. Levels are labeled by **workload steps / approximate prompt bytes**, *not* measured token depth (we do not claim token accounting we don't have).

## Isolation (§27, §33)

Every trial gets a throwaway `CTX_HOME` and a throwaway git repo under the OS temp dir. The developer's real `~/.ctx` is never touched. Control trials run with ctx env vars scrubbed and are asserted ctx-free. No secrets in fixtures.

---

## Commands

```bash
# Validate the dataset + print the plan; calls no agent (§29)
bun run bench:memory -- --dry-run --split all

# Tiny demo: 5 scenarios, control vs ctx, mock agent (§45)
bun run bench:memory:demo
bun run bench:memory:demo -- --fresh      # show the fresh-session contrast

# Harness self-tests (offline, deterministic)
bun test benchmarks/developer-memory/tests/scorers.test.ts \
         benchmarks/developer-memory/tests/schema.test.ts \
         benchmarks/developer-memory/tests/stats.test.ts \
         benchmarks/developer-memory/tests/results-resume.test.ts

# ctx participation / contamination / poisoning / scope checks against the REAL ctx CLI (no model)
bun run bench:memory:check

# Typecheck the benchmark
bun run bench:memory:typecheck

# Full run against a real agent — GATED (needs the enable flag + --yes). Never runs by accident.
CTXBENCH_ENABLE_CLAUDE=1 CTXBENCH_MODEL=claude-... bun run bench:memory:full -- --agent claude --trials 5 --fresh --yes
```

Useful flags: `--agent mock|claude`, `--condition control|ctx|agentsmd` (repeatable), `--category <c>`, `--scenario <id>`, `--split dev|heldout|all`, `--trials N`, `--seed N`, `--fresh`, `--sweep`, `--max-scenarios N`, `--max-trials N`, `--run-id <id>` (resume), `--out <dir>`.

### Resume (§31)
Each trial is persisted immediately to `trials.jsonl` (append-only). Re-run with the same `--run-id` to skip completed trials and retry only infrastructure errors.

## Outputs (§28)

```
benchmarks/results/<run-id>/
  manifest.json                   # benchmark version, dataset hash, ctx SHA/version, agent/model, OS, seed, date
  trials.jsonl                    # one record per trial (raw, append-only)
  summary.json                    # computed metrics (Wilson 95% intervals)
  README-snippet.md               # generated markdown report (never auto-written to the project README)
  retention_vs_interference.csv   # chart data (§36)
  condition_comparison.csv
  context_cost.csv
  charts.json
  failures/                       # sanitized failure artifacts (§57)
```

## Metrics (§22)

Preference adherence; fresh-session retention; cross-agent retention; heavy-interference retention; conditional precision; update accuracy; poisoning resistance; false-positive rate; context cost (median/p95 injected chars & approx tokens, tokens-per-successful-adherence); ctx retrieval overhead. Binary metrics carry a **Wilson 95% interval** and always show `n` (e.g. `96% (96/100)`). Headline deltas report control vs ctx vs absolute pp.

## Agents (§47–§49)

- **`mock`** — a deterministic harness fixture (not a model). It models an agent whose adherence depends on whether the preference is visible at probe time (bounded context window; ctx-injected context always visible). Used for harness validation and `--dry-run`. **Mock numbers are never a product result.**
- **`claude`** — Claude Code headless. Gated behind `CTXBENCH_ENABLE_CLAUDE=1` + `--yes`; **unvalidated** until a credentialed pilot confirms its stream-json tool-event parsing. Cursor is not headlessly automatable here and is intentionally absent rather than faked (§48).

## Honest limitations

- **Mock ≠ model.** The pilot numbers below validate the pipeline; they are not evidence about any real agent.
- **Latency.** The reported ctx "retrieval overhead" is wall-clock of a `bun src/index.ts` subprocess, so it is dominated by interpreter startup (~0.5s) and is an **upper bound**, not ctx's internal retrieval time. The true context cost is the envelope's `renderedChars`/`approxTokens`, which are exact.
- **Conditional/abstention scenarios** often require a real agent; the mock reports them `unsupported` (excluded from rates) rather than guessing.
- **Scope-leak** is measured at the ctx **delivery** layer (the `bench:memory:check` test) and under fresh sessions; in a same-session trial the conversation itself legitimately carries the preference.

See `AUDIT.md` (initial state), `FINDINGS.md` (behavioral findings, recorded not fixed — §58), and `FEASIBILITY.md` (LongMemEval / LoCoMo).
