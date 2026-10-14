# Autonomous-save write-surface fix — report

Status: implementation + deterministic + ≤8-call real pilot complete. **Not committed.**
Branch `freeze/developer-memory-v1.1`, baseline commit `57ed306`.

---

## 1. Why Claude previously chose the human commands

Not a permissions gap — the install already auto-approves ONLY `ctx agent remember|propose|
signal add` and never the bare human writes (verified). The cause was **affordance +
prior**: (a) the model has a strong prior for the short, canonical-sounding `ctx remember`
/`ctx signal add`; (b) in `renderSaveGuidance` the "never bare" rule sat at the very END,
after the examples, with no reason given; (c) the previous pilot ran under
`bypassPermissions`, so the bare command silently succeeded and the model felt no friction
to switch.

## 2. Agent-facing policy change

`src/core/assets/save-policy.ts`: new `renderWriteSurface(cmd)` — stated FIRST (before the
examples), as an unmistakable rule WITH its reason: the agent surface is the only
provenance-safe, auto-approved path; the bare commands are NOT auto-approved and will
interrupt for permission, so never use them for an autonomous write. Same text embedded in
the Claude standing block (`CTX_INSTRUCTION_BLOCK`). Plus a terse-durable cue ("a terse
standalone preference still counts — persist it, then continue") and a durable-vs-temporary
contrast block.

## 3. Safe write commands exposed

`ctx agent remember --origin user --scope <global|repo> "<rule>"` (preference),
`ctx agent signal add --origin user --domain <d> --choice <c>` (decision),
`ctx agent propose --origin user --evidence "<e>" "<rule>"` (inferred, rare). MCP:
`remember` / `record_decision` / `propose` (origin required).

## 4. Permission behavior — before/after

UNCHANGED (already correct; verified by new tests): auto-approve `Bash(ctx[.cmd] agent
remember|propose|signal add:*)` + reads; `prefs approve/reject` gated (deny); bare human
writes, `forget`, `signal clear`, `env`, `setup`, `install`, `uninstall` never auto-approved;
no `Bash(*)`. Retired bare-write rules are pruned on repair. No broadening in this pass.

## 5. Terse-preference policy change

Added the standalone-is-actionable cue + a 4-pair durable↔temporary contrast
(`SAVE_EXAMPLES_CONTRAST`), judged by MEANING (no keyword matching). Also fixed the pilot
harness to present the policy as a SYSTEM prompt (`--append-system-prompt-file`) and the
user line as the actual prompt — mirroring CLAUDE.md + user turn — which is what actually
unblocked recognition (see §6/pilot).

## 6. Deterministic durable-vs-temporary results

Benchmark `TERSE` group (§11): 4 durable → preference, 4 temporary → nothing. Deterministic
write-path validation: **39/39** (all expected outcomes achievable; non-user authoritative
writes refused). `bun test` policy/permission assertions all green.

## 7. Files changed

`src/core/assets/save-policy.ts` (write-surface rule + contrast), `src/adapters/claude/
skills.ts` (standing block), `src/cli/index.ts` (agent vs human command descriptions),
`skills/*/SKILL.md` (regenerated — unchanged bytes), `tests/save-policy.test.ts`,
`benchmarks/autonomous-save/{scenarios,harness,score,cli}.ts` + `tests/score.test.ts`.

## 8. Tests added

`tests/save-policy.test.ts`: +7 (write-surface rule prominence & reason; terse contrast;
standing-block foregrounding; permission allow/deny matrix for linux+win incl. "bare NOT
allowed / destructive absent / retired prunable"; Codex rules; human commands still exist).
Benchmark score test: +2 (write-surface classifier; system-prompt vs user-turn split).

## 9. Product test totals

`bun run typecheck` clean (root + bench). `bun run smoke:mcp` PASS. **`bun test` → 904
pass / 0 fail / 7 skip** (911 across 133 files). Deterministic save 39/39. No regressions
in pull-retrieval, provenance, memory-protocol, signals, conflict, or permission/install
tests.

## 10. Real Claude calls: 8 total (cap 8)

Three pilots, all `claude-sonnet-4-6`, Claude Code `2.1.181`, isolated CTX_HOME + git repo
+ `ctx` shim → this tree, hooks disabled:
- Pilot A (3, policy in prompt, bypass): surfaced the issue.
- Pilot B (3, policy as SYSTEM prompt, bypass): recognition FIXED; surface still bare.
- Pilot C (2, **production boundary**, `--permission-mode default`): the decisive test.

## 11. Model/version

`claude-sonnet-4-6`; Claude Code `2.1.181`.

## 12. Command-path result (the headline)

Under the PRODUCTION permission boundary (Pilot C), by effective (persisted) surface:
- `S-redis-cache` → **agent surface** directly: `ctx.cmd agent signal add --origin user
  --domain caching --choice redis` (0 denials). PASS.
- `T-pnpm-durable` → model tried bare `ctx remember` first → **DENIED** (1 denial) →
  **self-corrected** to `ctx.cmd agent remember --origin user --scope repo "…"`, which
  persisted. The only memory written came from the safe surface. PASS (effective).
- **Effective safe-surface rate: 2/2. Bare writes that PERSISTED (unsafe): 0.**

Under `bypassPermissions` (Pilots A/B), where the boundary is masked, the model sometimes
used the bare surface and it silently succeeded — confirming the boundary (not wording
alone) is what guarantees the safe path.

## 13. Resulting preference state (`T-pnpm-durable`, Pilot C)

One effective preference `scope=repo`, rule "Use pnpm as the package manager (not npm or
yarn)." (means use pnpm), origin=user, polarity positive, no duplicate, not a signal, not a
proposal. Recall 1/1, Precision 1/1, Scope 1/1.

## 14. Temporary-override result

`T-pnpm-temp` ("Use pnpm for this command.") across pilots → **no durable write** (Ignore
Precision 1/1; no authoritative preference created).

## 15. Signal-path result

`S-redis-cache` → `ctx agent signal add --origin user` (agent surface), a signal recorded,
**no authoritative preference** created. Signal Recall 1/1.

## 16. Use of human write commands

Under the production boundary: one bare `ctx remember` ATTEMPT (T-pnpm-durable) that was
DENIED and wrote nothing; the model then used the agent surface. Zero bare writes persisted.

## 17. Provenance violations

None. (Provenance guards unchanged; adversarial/poison not re-piloted this pass but covered
deterministically and in the prior pass at 1/1.)

## 18. Duplicate / unnecessary writes

0 duplicates; 0 unnecessary writes across the pilots.

## 19. Estimated cost

Pilot A $0.24 + Pilot B $0.63 + Pilot C $0.40 = **~$1.27** total for 8 calls.

## 20. Is silent autonomous saving now viable?

**Yes, safely — with one caveat.** Under the real permission boundary the agent never
persists via the unsafe surface: a bare attempt is denied and the model self-corrects to
`ctx agent remember --origin user`, so the stored memory is always provenance-safe and
correct (right scope/origin, no dup). Recognition of terse durable preferences is now
reliable (the system-prompt framing fix). Caveat: the model may still TRY the bare command
first (one denial) before self-correcting — so the very first attempt isn't always silent,
though it is always SAFE and recovers automatically. Fully first-try-silent behavior is not
yet guaranteed by wording alone.

## 21. Remaining blind spots

- The model's `ctx remember` prior still fires first sometimes; the boundary catches it, but
  first-try silence isn't guaranteed. A deeper fix (not done — would risk redesign/over-reach)
  could make the bare commands emit an agent-redirect hint on denial, or elevate
  `ctx agent remember` as the documented primary so future model priors favor it.
- Pilot C (the realistic boundary) only covered the two write cases; ignore/adversarial were
  validated under bypass + deterministically, not re-run under the boundary.
- Headless `--permission-mode default` denial semantics approximate, not identical to, an
  interactive host (no human approval step).
- Claude-only; the policy is agent-neutral but Codex/Cursor not piloted.
