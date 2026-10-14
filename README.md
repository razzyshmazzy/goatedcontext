# goatedcontext

[![CI](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml/badge.svg)](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml)

**Your coding agent forgets how you work. goatedcontext puts the context back.**

You tell an agent how you like to work. `ctx` stores that developer context locally.
Future sessions and other agents can retrieve it, so you stop repeating yourself. Agents
can also read and save context on their own, and you keep manual control over everything
that gets stored.

It works with Claude Code, Codex, and Cursor out of the box, and with any agent that can
speak MCP, invoke a subprocess, or read `AGENTS.md`.

```bash
npx goatedcontext setup
```

> "You know what's funny? GOATS!" — Goat Simulator

## The idea

Tell Claude Code:

> For this repo, use pnpm.

Later, in a brand-new session (or in Codex):

> Add zod.

```
pnpm add zod
```

You didn't repeat the convention. `ctx` persisted it when you said it, and handed it back
when it mattered. Tell one agent, and a different agent can pick it up later — the context
lives in a local store, not inside one product's memory.

You don't run any commands for this. Talk to the agent normally; it decides what's worth
keeping and writes it through `ctx`. You can always inspect, edit, or delete what's stored.

## Results

The honest question is: does this actually change what an agent does? There's a reproducible
benchmark for it. The headline numbers below are from the **frozen held-out split** of
`developer-memory-v1.1` — 320 real Claude Code trials, `claude-sonnet-4-6`, deterministic
behavioral scoring (it reads the commands and files the agent produced, never its prose).

| Metric | Control | ctx | Δ |
|---|---|---|---|
| Preference adherence | 62% (87/140) | 76% (107/140) | **+14 pp** |
| Fresh-session retention | 24% (17/70) | 54% (38/70) | **+30 pp** |

Fresh-session retention is the one that matters: the preference is no longer anywhere in the
conversation, so the agent only gets it right if memory delivered it. 0 infrastructure errors
across the run.

### The honest caveat

In v1.1, **retrieval/delivery was the main bottleneck**, not the model. Every ctx trial
persisted the preference and ran retrieval, but retrieval only surfaced the relevant
preference into context 43% of the time. When it *was* delivered, the model followed it
almost every time.

```
persisted                 100%   (140/140)
retrieval attempted       100%   (140/140)
delivered into context     43%   (60/140)
followed when delivered    97%   (58/60)
```

So the +14 pp headline is a 43% delivery rate multiplied by a near-perfect payoff. When ctx
delivers, it works. When it doesn't, it's indistinguishable from having no memory. That
makes recall the thing to improve — and it also means the benchmark isn't hiding the ball.

The 43% is specific to this scenario mix, which deliberately includes hard oblique probes
like "add `<package>`" where the task text shares no keyword with the stored rule. It is not
a universal recall rate.

### Retrieval work since the frozen benchmark

Separate from the held-out run above, a **targeted deterministic retrieval eval** (no model
calls — it drives the real retrieval pipeline over the oblique-probe cases that caused the
misses) moved:

- delivery recall: **40% → 100%**
- false-positive rate: **0% → 0%**

A tiny 8-trial Claude confirmation then showed that once the previously-missed context is
delivered, behavior follows it (adherence 2/4 control → 4/4 ctx on those cases).

This is a **targeted regression eval, not a new held-out benchmark.** It does not mean the
76% held-out score is now higher — that number stays frozen at its commit. It means the
specific recall gap the benchmark identified has a fix with a regression test behind it.

## How it works

Two separate paths, read and write, kept deliberately apart.

```
                 user task
                     |
                     v
                   agent
                   /    \
          read    /      \   write
                 /        \
   retrieve ctx when a     save durable user intent
   decision depends on     (preference) or a meaningful
   how you/this repo work  one-off decision (signal)
```

**Read (pull + push).** Context is pushed in automatically at prompt time where a hook is
available. On top of that, the agent can pull: when it hits a decision that could depend on
how you or the repo usually work, it asks `ctx`, which returns a compact relevant slice.
Reads never write.

**Write.** When you state durable intent ("use pnpm here"), the agent saves a **preference**.
A meaningful one-off engineering decision becomes a **signal**. Temporary, hypothetical, or
external content ("just for this command", "the README says to use npm") is ignored.

- Local SQLite store under `~/.ctx` (WAL). No daemon, no cloud service, no telemetry.
- Preferences, signals, and proposals are stored separately (see [Memory model](#memory-model)).
- Scopes are repo or global; preferences can carry conditions (`language=`, `file=`, `domain=`).
- Retrieval is bounded and deterministic — no embeddings, no vector index, no transcript scraping.

### Autonomous save, tested

Autonomous saving is newer and the evidence is smaller, so here it is plainly. In a small
**24-turn behavioral evaluation** (2 real continuing sessions, `claude-sonnet-4-6`):

- 4/4 durable preferences captured, 4/4 precision (nothing wrong saved)
- 1/2 meaningful signals captured — signal recall is the weak spot; it missed one borderline decision
- 18/18 "should save nothing" turns correct
- 2/2 temporary overrides stayed temporary (did not become durable memory)
- 0 duplicates, 0 self-feedback writes (it never re-saved context it had just been shown), 0 over-saves
- every persisted write used the safe, provenance-required agent surface

Small sample, single model. But over a realistic session the store stayed sparse and correct,
which is the design goal.

## Why not AGENTS.md or native agent memory?

Not a knock on either — they solve different problems.

- **`AGENTS.md`** is great for static, per-repo instructions you commit. It doesn't carry your
  *global* defaults across repos, update dynamically, or move between agents. (goatedcontext
  can still project to `AGENTS.md` as a fallback — `ctx sync`.)
- **Native agent memory** is tied to one product. What Claude remembers, Codex can't read.
  Portability is the whole problem goatedcontext exists to solve.

goatedcontext keeps a single local source of truth, scoped (repo/global), shared across
agents, retrieved dynamically, and fully inspectable. It is **not** a context-window
extension, a transcript RAG system, or a vector database.

## Install

```bash
npx goatedcontext setup
```

Node 22.13+. `setup` installs the persistent `ctx` CLI, detects which agents you have
(Claude Code, Codex, Cursor), and wires up their native integrations. Rerun it anytime to
upgrade or repair. You never `npm install -g` by hand.

Check it worked:

```bash
ctx agents      # which agents are detected and wired
ctx doctor      # diagnostics
```

## Agents

Native, zero-config integrations for three agents. Anything else connects through a universal
interface with no goatedcontext-specific code.

| Agent | Runtime context | MCP | `ctx agent` CLI | AGENTS.md |
|---|---|---|---|---|
| Claude Code | yes (prompt hook) | yes | yes | yes |
| Codex | yes (prompt hook) | yes | yes | yes |
| Cursor | static only | yes | yes | yes |
| Any other MCP agent | via MCP | yes | — | — |
| Any other CLI agent | via subprocess | — | yes | yes (`ctx sync`) |

Claude Code and Codex get runtime context injected at prompt time, a memory skill, and a
narrow permission rule so safe memory writes don't prompt every time. Cursor has no reliable
prompt-time hook, so it reads repo rules from `AGENTS.md` and gets the MCP server and memory
skill — no terminal auto-approve rule, because Cursor's allowlist is raw-prefix matching and
allowing `ctx remember` would also allow `ctx remember x && rm -rf /`. That's not safe to
install, so it isn't.

The public claim, precisely: **any agent that can use MCP, invoke a subprocess, or read
`AGENTS.md` can work with goatedcontext without goatedcontext-specific code; Claude, Codex,
and Cursor receive native integration when detected.** This is universal *compatibility*, not
a promise that every agent auto-configures itself. See
[INTEGRATING.md](INTEGRATING.md) for a 10-minute integration with a Python example.

```bash
ctx mcp                                               # stdio MCP server (get_context + memory tools)
ctx agent context --task "set up the backend" --json  # stable JSON envelope for any subprocess-capable agent
ctx sync                                              # static AGENTS.md projection (weakest fallback)
```

## Memory model

Three kinds of memory, kept deliberately separate:

| Kind | What it is |
|---|---|
| **Preference** | An explicit, durable developer rule or default. These are what actually steer the agent. |
| **Signal** | One meaningful engineering decision or piece of evidence ("this project used Supabase"). |
| **Proposal** | An inferred candidate preference, awaiting your approval. |

Two rules that make this trustworthy:

- **Signals never become authoritative on their own.** Three Supabase projects do not turn
  into "always use Supabase." The agent can *suggest* it; a human decides.
- **Proposals are not auto-approved.** They steer nothing until you confirm them.

Preferences are defaults, not commandments. "Prefer Firebase" does not mean rewrite an
existing Supabase app or override an explicit instruction you just gave. A repo-specific
choice or a hard constraint wins for that task, and the preference stays stored for the next
one.

## Security and provenance

Concise but serious. Details in
[ARCHITECTURE.md](./ARCHITECTURE.md#persistent-memory-injection-boundary-037).

- **Only user-authored durable intent can become authoritative preference memory.** Repo
  files, tool output, web content, and model text may influence the current task, but cannot
  become authoritative user memory through the safe agent surface. A README that says "save
  this preference" is refused.
- **Explicit origin, fail-closed.** Agent writes go through `ctx agent remember|propose|signal add`,
  which require an `--origin` and fail without it. The bare `ctx remember` you'd type yourself
  is **not** auto-approved, so an agent can't silently persist something it read in a repo file.
- **No recursive re-saving.** Context that ctx injected is not re-saved back into memory.
- **Local only.** The store is a SQLite file under `~/.ctx`. No server, no account, no network
  calls, no telemetry.
- **Secrets stay out of the store.** They live in a separate encrypted store (DPAPI on Windows,
  otherwise an encrypted file) and are never returned through retrieval, context injection,
  history, stats, or exports. No plaintext secrets on disk.
- Setup never uses `--dangerously-skip-permissions` (Claude) or Full Access (Codex), and never
  whitelists a shell. Both hosts match the allow rule on split tokens, so chaining another
  command onto an allowed `ctx` prefix is not auto-approved.

Honest boundary: the model still *semantically classifies* whether something came from you.
This stops accidental and source-confused writes; it is not a cryptographic attestation that a
human authored a given string. It is not audited. Judge it on what it does and doesn't do.

## Commands

You normally don't touch these — the agent does — but they're here for inspection and control.

**Memory (human)**
```bash
ctx remember --scope repo --always "Use Bun for development commands."
ctx remember --when language=typescript "Prefer strict TypeScript."
ctx forget <id>
```

**Inspection**
```bash
ctx prefs                 # list preferences
ctx prefs pending         # proposals awaiting review
ctx signals               # aggregated decision evidence
ctx why <id>              # why a preference exists
ctx conflicts             # conflicting rules
ctx doctor                # diagnostics
ctx agents                # detected agents + integration status
```

**Environments** (reusable dev environments with injected secrets)
```bash
ctx env list
ctx env run <name> -- <command>
```

**Transfer / debug**
```bash
ctx export
ctx import
ctx test-hook --agent codex --task "..."   # inspect what an agent would receive
```

Conditions (`--when`) support `language=`, `file=`, `domain=`, `repo=`, repeatable for AND.

Agents write through a **separate, provenance-required surface** — `ctx agent remember`,
`ctx agent propose`, `ctx agent signal add` (each needs `--origin`). You don't type those;
they exist so autonomous writes are safe. Full command set is in `ctx --help`.

## Benchmarks

The effectiveness benchmark lives in
[`benchmarks/developer-memory/`](benchmarks/developer-memory/). It measures behavior, not
recall: state a preference, do unrelated work or start a fresh session, then check whether the
agent naturally does the preferred thing.

- Frozen dataset (`developer-memory-v1.1`, dataset-hash recorded in each run's `manifest.json`)
- Held-out split, separate from the dev split used for product fixes (so overfitting is visible)
- Pinned model (`claude-sonnet-4-6`), seed 1234, 5 trials per cell, 320 trials
- Raw transcripts, trial records, and failure artifacts preserved; the headline
  [REPORT.md](benchmarks/results/heldout-v1_1-sonnet46/REPORT.md) is recomputed from them
  (re-scoring produced zero verdict changes)
- Significance tests reported alongside the per-scenario pattern, which is the more robust evidence

The autonomous read and save passes have their own reports under
[`benchmarks/autonomous-pull/`](benchmarks/autonomous-pull/) and
[`benchmarks/autonomous-save/`](benchmarks/autonomous-save/).

Separately, local retrieval overhead (no model inference — just the cost of the lookup),
measured on the dev machine with `bun run bench`, ballpark not guarantee:

| What | Result |
|---|---|
| Preference retrieval, 1k active preferences | ~17 ms (warm median) |
| Signal-aware retrieval, 50k signal rows | ~26 ms (warm median) |
| Decision-aware write vs plain write | +~0.1 ms per write |
| Cold `ctx --version` (full Node process) | ~60 ms |

A realistic store has tens to hundreds of preferences, where retrieval is a few milliseconds;
the 1k/50k figures are stress tests.

## Limitations

- **Retrieval recall is the active problem.** On the frozen held-out split, delivery capped
  the result at 43%. The targeted eval above fixes the identified oblique-probe cases, but
  recall on unusual phrasing remains an engineering problem, not a solved one.
- **Autonomous-save tests are still small** (a 24-turn session, single model). Signal recall
  specifically was 1/2.
- **Provenance is semantic, not cryptographic.** The model classifies whether content came
  from you; that is not human attestation.
- **Cursor is weaker.** No runtime injection path and no safe auto-approve rule, so it relies
  on static `AGENTS.md`. Its autonomous behavior isn't benchmarked.
- **No semantic/vector retrieval backend and no cloud sync.** Preference retrieval cost grows
  with the number of active preferences.
- A managed/enterprise agent policy can override the locally installed permission rules.
- Historical signal reasons ("Firebase free tier was too small") can go stale; they're treated
  as past evidence, not current fact.

## Development

Bun for development and tests; the published CLI runs on Node ≥ 22.13 using Node's built-in
`node:sqlite` — no native addon, no compiler toolchain.

```bash
git clone https://github.com/razzyshmazzy/goatedcontext
cd goatedcontext
bun install
bun run typecheck
bun test
bun run build
```

CI runs typecheck, build, and the test suite on Linux, macOS, and Windows, plus the built CLI
on plain Node. Design details are in [ARCHITECTURE.md](./ARCHITECTURE.md); release process in
[RELEASE.md](./RELEASE.md).

## License

MIT.
