# Autonomous-save benchmark

One question: **given a developer turn, what (if anything) should be persisted to ctx?**

The agent must distinguish three outcomes:

1. a durable default/convention the USER states → **preference** (`remember`)
2. a meaningful one-off engineering decision → **signal** (`signal add`)
3. everything else → **save nothing**

Separate from the developer-memory and autonomous-pull sets; not tuned on held-out
data. This pass is write-judgment only (the inverse of autonomous-pull's read-judgment).

## Scenarios (`scenarios.ts`)

Balanced core of **8 preference + 8 signal + 8 ignore**, plus **5 adversarial
provenance** cases (quoted README/tool/comment/web content that must NOT become
authoritative memory, and one user *adoption* that should) and **2 correction** cases
(a durable correction that supersedes, and a temporary override that must not replace a
durable default).

## Metrics (`score.ts`) — scored against ACTUAL ctx state, never prose

Preference Capture Recall/Precision, Signal Recall, Ignore Precision, Provenance
Safety, Scope Accuracy, Update Accuracy, Duplicate Write Rate, Unnecessary Write Rate —
each an exact numerator/denominator. Plus the failure taxonomy (`missed_preference`,
`over_saved_preference`, `signal_as_preference`, `preference_as_signal`,
`missed_signal`, `temporary_saved`, `provenance_violation`, `wrong_scope`,
`stale_rule_not_superseded`, `duplicate_write`, `under_normalized`,
`infrastructure_error`).

## Commands

```bash
# No model — verify the write path supports each expected outcome and that
# non-user authoritative writes are refused.
bun run bench:save:deterministic

# Pure scoring/schema unit tests (safe in `bun test`).
bun run bench:save:check

# Real-model pilot — HARD-CAPPED at 10 calls, gated + cost-guarded.
CTXBENCH_ENABLE_CLAUDE=1 CTXBENCH_MODEL=claude-sonnet-4-6 bun run bench:save:pilot
```

Each pilot trial runs in a **fresh isolated sandbox** (own `CTX_HOME` + git repo), with
the host push hook disabled (`--settings {disableAllHooks:true}`) and a PATH `ctx` shim
routing to this working tree. The prompt is the standing save policy (from
`src/core/assets/save-policy.ts`) + the user turn. After the turn, ctx state is read
back (`ctx prefs/signals --json`) and scored. Saving is expected to be **sparse** — the
default is to write nothing.
