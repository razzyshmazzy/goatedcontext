# ctx — Live Claude-Worker Dogfood Report V2 (Proactive Retrieval Hook)

A second live integration test with **real Claude Code workers** (`claude -p`,
headless), after adding a `UserPromptSubmit` hook that proactively injects relevant
`ctx` context before Claude reasons. Directly compares against
`CLAUDE_WORKER_DOGFOOD_REPORT.md`.

---

## Before vs after

| Metric | V1 (skill/CLAUDE.md only) | V2 (prompt hook) |
|--------|---------------------------|------------------|
| Meaningful autonomous retrieval opportunities | ~9 | 20 tasks (+1 pilot) |
| Automatic `ctx get` / hook executions | **2** | **20 / 20 (100%)** |
| Misses (meaningful task, no retrieval) | **7** | **0** |
| Relevant context injected | n/a (retrieval rarely happened) | **18 / 18 meaningful tasks** |
| Irrelevant injections | n/a | **0** (2 trivial tasks correctly injected nothing) |
| Duplicate manual `ctx get` by Claude | n/a | **0** |
| Repo override applied through Claude | 1 of 2 (mobile missed → used bun) | **2 of 2** (payments npm, mobile pnpm) |
| Proposal provenance populated | **0 / 22** | **2 / 2** proposes carry `agent-id` + `session-id` |
| Concurrency failures | 0 | 0 |

**New numbers (this run):**

```
meaningful tasks:            18 (of 20 matrix tasks; 2 were trivial) + 1 pilot
hook executions:             20 / 20   (100%)
successful retrievals:       20 / 20   (ctx get inside hook returned cleanly)
relevant injections:         18        (every meaningful task)
missed injections:           0         (no case where relevant prefs existed but weren't injected)
irrelevant injections:       0         (both trivial tasks: injected=no, n=0)
duplicate Claude ctx calls:  0         (workers never re-ran ctx get after the hook)
```

The core V1 gap — Claude skipping retrieval on 7/9 meaningful decisions, especially
non-dependency ones — is closed. Retrieval no longer depends on the model choosing
to call ctx; the hook runs deterministically on every prompt.

---

## Environment

| Item | Value |
|------|-------|
| ctx version | 0.1.2 |
| Claude Code version | 2.1.181 |
| OS | Windows 11 (10.0.26200) |
| Commit | `020ae95` + uncommitted 0.1.2 changes |
| Hook mechanism | `UserPromptSubmit` hook in Claude `settings.json` → command `ctx hook claude-prompt` → same `RetrievalEngine`; stdout injected as context |
| Isolation | temp `CTX_HOME`, temp `CLAUDE_CONFIG_DIR` (credentials copied), `CTX_SECRET_BACKEND=file`, `CTX_HOOK_DEBUG=1` for per-fire logging |
| Orchestration | 20 real `claude -p --permission-mode bypassPermissions --output-format json` workers in 3 concurrent waves (8/8/4) + 1 pilot |

---

## Worker matrix

Hook fired for **every** worker (confirmed in `hook.log`). "Injected" = the hook
returned a non-empty `<ctx-developer-context>` block. "Manual ctx" = worker ran
`ctx get`/`ctx propose` itself.

| Worker | Repo | Category | Hook | Injected | Manual ctx | Behavior / result |
|--------|------|----------|------|----------|-----------|-------------------|
| P1 (pilot) | payments | formatting/testing | ✓ | ✓ (testing) | none | `Intl` formatter, ran tests; no dep — exit 0 |
| A_ARCH | payments | architecture | ✓ | ✓ | none | **extended PaymentService** (reused existing) — exit 0 |
| A_DB | payments | database | ✓ | ✓ | none | added negative-amount guard — exit 0 |
| A_TEST | payments | testing | ✓ | ✓ | none | improved coverage — exit 1 (max_turns) |
| A_DEBUG | payments | debugging | ✓ | ✓ | none | root-cause task — killed at 300s (harness) |
| A_UI | mobile | ui | ✓ | ✓ | none | dark-mode toggle — exit 0 |
| A_STATE | mobile | state | ✓ | ✓ | none | loading state — exit 1 (max_turns) |
| A_ARCH2 | mobile | architecture | ✓ | ✓ | none | analytics client — exit 1 (max_turns) |
| A_DBM | mobile | state/db | ✓ | ✓ | none | persist theme — exit 1 (max_turns) |
| B_DEPA | payments | dependencies | ✓ | ✓ | none | **used npm** (`package-lock.json`) — exit 0 |
| B_DEPB | mobile | dependencies | ✓ | ✓ | none | **used pnpm** (`pnpm-lock.yaml`) — exit 0 |
| B_LEARN1 | payments | learning | ✓ | ✓ | **ctx propose** | proposed "integer cents" w/ provenance — exit 0 |
| B_LEARN2 | mobile | learning | ✓ | ✓ | **ctx propose** | proposed "composition>inheritance" w/ provenance — exit 0 |
| B_SECRET | payments | secrets | ✓ | ✓ | **ctx env run** | ran tests in supabase-test env; no secret printed — exit 0 |
| B_TESTM | mobile | testing | ✓ | ✓ | none | added settings test — exit 0 |
| B_TRIV1 | payments | trivial | ✓ | **✗ (correct)** | none | fixed a comment — exit 0 |
| B_TRIV2 | mobile | trivial | ✓ | **✗ (correct)** | none | renamed a variable — exit 0 |
| C_ARCH | payments | architecture | ✓ | ✓ | none | refund capability — exit 0 |
| C_DB | payments | database | ✓ | ✓ | none | null-amount guard — exit 0 |
| C_UI | mobile | ui | ✓ | ✓ | none | font-size setting — exit 0 |
| C_DEBUG | mobile | debugging | ✓ | ✓ | none | stale-theme root cause — exit 1 (max_turns) |

**exit 1 / killed (6):** all `error_max_turns` or the 300s harness timeout on the
debugging task — the hook fired and injected for every one; these are turn/time-cap
artifacts of the test harness, **not** ctx, hook, or concurrency failures.

---

## Non-dependency tasks (the V1 blind spot)

V1 auto-retrieved almost only for dependency-shaped tasks. V2 injected relevant
context for **every** non-dependency category:

- **architecture** — A_ARCH, A_ARCH2, C_ARCH: injected; A_ARCH visibly extended the
  existing `PaymentService` rather than adding a parallel layer.
- **database** — A_DB, C_DB: injected the relational-integrity preference; both added
  integrity guards (app-level `throw` — the toy repo has no real schema for a DB
  `CHECK` constraint, so full "relational constraint" behavior couldn't be exercised;
  the *context was present*, which was the goal).
- **testing** — A_TEST, B_TESTM, P1: injected; P1's "test it" phrasing pulled in the
  "don't claim completion until tests run" rule and the worker ran tests.
- **debugging** — A_DEBUG, C_DEBUG: injected (root-cause preference present).
- **UI / state** — A_UI, C_UI, A_STATE, A_DBM: injected the mobile "UI state local"
  / "platform-native" rules.

---

## Concurrency

| Item | Result |
|------|--------|
| Workers | 20 (waves of 8, 8, 4) + pilot |
| Max parallelism | 8 concurrent workers, each firing a prompt hook |
| Hook calls | 20 (one per worker) + standalone latency probes |
| DB lock errors | **0** (`grep database is locked` across all logs → none) |
| Deadlocks | none (all workers exited; no hangs beyond the intended 300s cap) |
| Latency regression | none material (see below) |
| State corruption | none — `PRAGMA integrity_check = ok` |
| Repo leakage | none — payments hooks injected payments rules; mobile hooks injected mobile rules |

Additional stress: 10 concurrent `ctx hook claude-prompt` processes against a
120-preference home completed in **439 ms wall** with 0 lock errors (reads
parallelize under WAL; the hook is read-only — `track:false` — so it never takes the
write lock).

**Hook latency**

| Scenario | Time |
|----------|------|
| empty home | ~154 ms |
| 18 preferences | ~213 ms |
| 120 preferences | ~141 ms |

Dominated by Bun/TS cold start (~150 ms); retrieval itself adds only a few ms and
does not grow meaningfully with preference count. No daemon needed. Effectively
instantaneous relative to a model turn.

---

## Provenance

Both learning proposals carried real provenance (the `context-learn` skill now
instructs `--agent-id claude-code --session-id "$CLAUDE_CODE_SESSION_ID"`):

```
propose --agent-id claude-code --session-id 15bf6a35-... --category architecture ... (composition over inheritance)
propose --agent-id claude-code --session-id 49eb0ea2-... --category data-modeling  ... (integer cents)
```

In the DB, both proposals' evidence rows have `agent_id = claude-code` and a session
id — versus **0/22** in V1.

---

## Secrets

- No fake secret string (`FAKE_ANON_sb_v2_9c1x`, `FAKE_OPENAI_sk_v2_7z2q`,
  `fake.supabase.invalid`) appeared in any worker log, the ctx invocation log, the
  hook log, or `ctx.db`.
- The injected `<ctx-developer-context>` block lists environment **names** only
  (e.g. `supabase-test`) — never values (verified by unit test + live scan).
- B_SECRET used `ctx env run supabase-test -- bun test` and an env-name-only probe;
  it printed "X is set", never a value.

Zero secret leakage through the hook or anywhere else.

---

## Fixes shipped in 0.1.2

- **Proactive retrieval hook** — `ctx install claude` registers a `UserPromptSubmit`
  hook (`ctx hook claude-prompt`) that calls the existing engine and injects a
  compact block; empty/irrelevant → injects nothing.
- **`ctx prefs pending --json`** now emits JSON (regression test added).
- **`ctx status`** reports the hook: `✓ proactive retrieval hook installed` /
  `! proactive retrieval hook missing`.
- **`ctx install claude --disable-hook`** cleanly removes the hook (keeps skills &
  prefs); installs are idempotent, atomic, preserve unrelated hooks/settings, and
  upgrade a v0.1.1-style install by adding the hook.
- **Provenance** via updated `context-learn` skill.
- Skills reworded: retrieval is auto-injected; manual `ctx get` reserved for refresh.

87 automated tests pass (was 70); `bun run typecheck` clean; full suite stable
across repeated runs.

---

## Remaining issues / honest caveats

- **Custom `--hook-command` lacking the `hook claude-prompt` token breaks
  detection/idempotency** (the marker is that substring). The default command is
  fine; documented. Low severity.
- **Injection ≠ obedience.** The hook guarantees relevant context is *in front of*
  the model; whether Claude fully applies each rule still varies (e.g. database tasks
  added app-level guards rather than DB constraints — partly because the test repo
  has no real schema). This is expected for advisory context and is a large
  improvement over V1, where the context usually wasn't there at all.
- **6/20 workers hit `error_max_turns`/timeout** — a harness turn/time cap, not a
  product issue; hooks fired for all of them.
- Hooks were observed firing under headless `-p`; behavior in every interactive
  configuration was not separately exercised.

---

## Final recommendation

### Ready for Windows limited external alpha.

The live evidence supports it: with the prompt hook, **relevant developer context is
now delivered automatically and reliably (20/20 hook executions, 18/18 relevant
injections, 0 misses, 0 irrelevant injections, 0 duplicate retrieval)** — the single
blocker from the previous report. The engine remains robust under real concurrent
workers (0 lock errors, 0 corruption, 0 leakage, integrity ok), repo precedence now
reaches Claude's actions end-to-end (npm vs pnpm both correct), secrets never leak,
proposals carry provenance, and the hook is fast, fail-open, idempotent, and
removable. The remaining items are minor and documented. Recommend a Windows-first
limited external alpha, keeping the `--hook-command` marker caveat and macOS/Linux
secret backends (still file-fallback) on the near-term list.
