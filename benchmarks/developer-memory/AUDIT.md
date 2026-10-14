# Audit — initial state (spec §0)

Performed before any benchmark code was written. Read-only; no product behavior changed.

## Repo state
- Branch `main`, version **0.4.1**, working tree clean at audit time.
- Runtime: Bun 1.4.2, Node ≥22.13, SQLite (WAL), deps: `commander`, `zod` (+ MCP SDK dev dep).

## Test suite
`bun test` → **778 pass / 7 skip / 1 fail** across 121 files (~160s).
- The single failure is `tests/hook-large-prompt.test.ts` → *"retrieval latency stays flat as prompt size grows 1KB→2MB"*, a **machine-dependent performance-threshold** assertion (expected < ~114ms, observed ~239ms) that trips when the box is under load. It is **not** a functional/correctness failure. Per §58 no product code was touched. The functional suite is green.

## Integration surfaces the benchmark uses (all read-only; shipped public interface)
- **`ctx agent context --json` / `--stdin`** → the stable **v1 envelope** (`buildContextEnvelope`): `authoritativePreferences`, `observedPatterns`, and `meta.diagnostics` with `renderedChars`, `approxTokens`, `omittedByBudget`, `overflow`. Gives exact **context-cost** metrics for free (§38).
- **`ctx hook claude-prompt | codex-prompt | cursor-session`** → the proactive-retrieval hook (stdin `{cwd,prompt}` → stdout text block). The authentic native-injection path; fails open.
- **`ctx mcp`** → MCP stdio server, reuses the same envelope builder (CLI/MCP parity).
- **Write paths:** `ctx remember` (human/user-origin default) vs **`ctx agent remember --origin <user|project|external>`** (provenance-required; auto-allowed path). The agent path fails closed without `--origin`.
- **Provenance guard** (`src/core/provenance.ts` + `preferences/service.ts::assertUserOriginated`): only `origin=user` may create/strengthen a durable preference; `project`/`external`/`agent`/`unknown` are refused. This is the mechanism the poisoning category exercises.

## Isolation primitives
- `CTX_HOME` env var fully redirects home/db/config/secrets (`src/storage/paths.ts::resolvePaths`). A subprocess `ctx` with `CTX_HOME=<tmp>` is fully isolated.
- Reusable patterns in `tests/helpers.ts` (`makeGitRepo`, isolated context) and `tests/bench/fixtures.ts` (Mulberry32 seeded PRNG) — the benchmark reuses the seeded-PRNG convention.

## Existing bench scripts
`scripts/bench/diagnostics.ts` and `scripts/bench/memory-bloat.ts` are **performance** diagnostics (scale/cache/latency), not preference-retention benchmarks. No overlap; nothing to repurpose except isolation patterns.

## Decision
Build a clearly separate suite under `benchmarks/developer-memory/`, importing **no** production TypeScript (it re-declares the public envelope shape locally), consuming only the shipped `ctx` CLI. Production ctx is untouched.
