# Autonomous-pull benchmark

A small, focused benchmark that answers exactly ONE question:

> **Should the agent proactively call ctx for this task — and does it?**

It is deliberately separate from the full developer-memory benchmark and does **not**
reuse held-out v1.1 scenarios as tuning data. It targets the v1.1 "pull" pass:
teaching an agent to recognize *"this decision may depend on established
developer/project context"* and retrieve it, while abstaining on tasks where memory
clearly does not matter.

## Scenarios (`scenarios.ts`)

18 total: **9 memory-relevant** (one per decision class — dependency, testing,
database, language/runtime, framework/tool, repo-convention, architecture,
conditional-convention, state-management) and **9 memory-irrelevant** (general/
factual/conceptual tasks). Each relevant scenario seeds one realistic preference;
irrelevant scenarios seed nothing, and the relevant seeds use `relevant`
applicability so they never surface for an unrelated task.

## Metrics (`score.ts`)

Reported as exact numerator/denominator (never a fabricated percentage at tiny n):

1. **Tool Recall** — relevant tasks where the agent called ctx / all relevant tasks
2. **Tool Precision** — relevant ctx calls / all ctx calls
3. **Unnecessary Call Rate** — irrelevant tasks where the agent called ctx / all irrelevant
4. **Retrieval Success After Call** — calls where ctx returned the expected preference
5. **Adherence After Pull** — retrieved-and-relevant cases where behavior followed it

Plus the failure taxonomy: `no_call`, `bad_query`, `retrieval_miss`, `duplicate_call`,
`unnecessary_call`, `adherence_failure`, `infrastructure_error`.

## Commands

```bash
# No model — ground truth: does ctx return the right thing for each task?
bun run bench:pull:deterministic

# No model — prove tool-call capture works on a synthetic transcript
bun run benchmarks/autonomous-pull/cli.ts parse-check

# Pure scoring/schema unit tests (safe in `bun test`)
bun run bench:pull:check

# Real-model pilot — HARD-CAPPED at 10 calls, gated + cost-guarded
CTXBENCH_ENABLE_CLAUDE=1 CTXBENCH_MODEL=claude-sonnet-4-6 \
  bun run bench:pull:pilot --relevant 3 --irrelevant 3
```

The pilot prints a cost guard (planned scenarios, invocations, model, estimate) and
**stops** if the plan exceeds the cap. It is gated behind `CTXBENCH_ENABLE_CLAUDE=1`
and `CTXBENCH_MODEL`; without them it prints the plan and makes no calls. Each trial
composes the standing pull instruction (from `src/core/assets/retrieval-policy.ts`,
the exact text under test) with the probe, runs Claude Code headless in an isolated
sandbox with its own `CTX_HOME`, and observes whether the model autonomously ran
`ctx get` / `get_context`. Transcripts and a `pilot-result.json` are written under
`benchmarks/results/autonomous-pull-transcripts/`.

This pass is **retrieval-only**: pulling context never writes memory.
