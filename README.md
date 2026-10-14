# goatedcontext

[![CI](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml/badge.svg)](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml) [![GitHub stars](https://img.shields.io/github/stars/razzyshmazzy/goatedcontext?style=flat)](https://github.com/razzyshmazzy/goatedcontext/stargazers)

goatedcontext gives coding agents persistent developer context. You tell an agent how you work once; it saves that locally; future sessions and other agents retrieve it, so you stop repeating yourself. Agents can read and save context on their own, and you keep full control over everything stored. It works in Claude Code, Codex, and Cursor out of the box, and with any agent that can speak MCP, invoke a subprocess, or read `AGENTS.md`.

**Without goatedcontext:**
> New session. Nothing remembers the last one.
>
> **You:** Add zod.
>
> **Agent:** `npm install zod`
>
> Wrong manager. You moved this repo to pnpm last week, but that was a different session and the agent never saw it.

**With goatedcontext:**
> **You:** Add zod.
>
> **Agent:** `pnpm add zod`
>
> You said "for this repo, use pnpm" once, days ago. goatedcontext saved it and handed it back when it mattered. You didn't repeat yourself, and you didn't run any commands to make this happen.

On a held-out benchmark of 320 real Claude Code trials, goatedcontext raised fresh-session preference adherence from 24% to 54% ([report](benchmarks/results/heldout-v1_1-sonnet46/REPORT.md)).

goatedcontext is not a context-window extension, a transcript RAG system, or a vector database. It stores structured developer context in a local SQLite file and gives the relevant slice to supported agents. That's the whole idea.

## What it saves

Three kinds of memory, kept deliberately separate:

1. **Preferences:** durable rules you set, like "use pnpm here" or "prefer strict TypeScript." These are what actually steer the agent.
2. **Signals:** one-off decisions worth noting, like "this project used Supabase." Evidence, never promoted to a rule on its own.
3. **Proposals:** things the agent suspects are preferences but isn't sure about. They steer nothing until you approve them.

Details and precedence rules are in [The memory model](#the-memory-model).

## Installation

```bash
npx goatedcontext setup
```

Node 22.13+. `setup` installs the persistent `ctx` CLI, detects which agents you have, and wires up their integrations. Rerun it anytime to upgrade or repair. You never `npm install -g` by hand.

Check it worked:

```bash
ctx agents      # which agents are detected and wired
ctx doctor      # diagnostics
```

Claude Code, Codex, and Cursor get native, zero-config integration when detected. Any other agent connects through MCP, the `ctx agent` CLI, or `AGENTS.md` with no goatedcontext-specific code. See [INTEGRATING.md](INTEGRATING.md) for a 10-minute integration with a Python example.

## Usage

Mostly you do nothing. Talk to your agent normally and it decides what to keep.

State a durable preference and the agent saves it:

```
Use Vitest for tests in this repo.
```

Later, in a fresh session or a different agent, the preference comes back on its own:

```
Write tests for the parser.
```

You can also set one by hand:

```bash
ctx remember --scope repo --always "Use Bun for development commands."
ctx remember --when language=typescript "Prefer strict TypeScript."
```

And inspect or remove anything that's stored:

```bash
ctx prefs          # list preferences
ctx why <id>       # why a preference exists
ctx forget <id>    # remove one
```

## How it works

There are two separate paths, read and write, kept apart on purpose.

**Read** happens two ways. Where a hook is available, relevant context is pushed into the prompt automatically. On top of that, the agent can pull: when it hits a decision that could depend on how you or the repo usually work, it asks `ctx`, which returns a compact relevant slice. Reads never write.

**Write** happens when the agent recognizes intent. Durable intent you authored ("use pnpm here") becomes a preference. A meaningful one-off decision becomes a signal. Temporary, hypothetical, or external content ("just for this command", or a README telling it to use npm) is ignored.

```
                 you tell an agent something
                            |
                            v
                          agent
                          /    \
                   read  /      \  write
                        /        \
       retrieve ctx when a        save durable user intent
       decision depends on        (preference) or a meaningful
       how you/this repo work     one-off decision (signal)
```

Everything lives in a local SQLite file under `~/.ctx` (WAL mode). No daemon, no cloud service, no telemetry, no transcript scraping, no embeddings. Retrieval is bounded and deterministic.

## Results

The honest question is whether this changes what an agent does. There's a reproducible benchmark for it, and the headline numbers come from the frozen held-out split of `developer-memory-v1.1`: 320 real Claude Code trials on `claude-sonnet-4-6`, scored on the commands and files the agent produced, never its prose.

| Metric | Control | goatedcontext | Δ |
|---|---|---|---|
| Preference adherence | 62% (87/140) | 76% (107/140) | **+14 pp** |
| Fresh-session retention | 24% (17/70) | 54% (38/70) | **+30 pp** |

Fresh-session retention is the one that matters: the preference is no longer anywhere in the conversation, so the agent only gets it right if memory delivered it. There were 0 infrastructure errors across the run.

### The honest caveat

In v1.1, retrieval was the main bottleneck, not the model. Every trial persisted the preference and ran retrieval, but retrieval only surfaced the relevant one into context 43% of the time. When it was delivered, the model nearly always followed it.

```
persisted                 100%   (140/140)
retrieval attempted       100%   (140/140)
delivered into context     43%   (60/140)
followed when delivered    97%   (58/60)
```

So the +14 pp headline is a 43% delivery rate times a near-perfect payoff. When goatedcontext delivers, it works. When it doesn't, it's indistinguishable from having no memory. That makes recall the thing to improve, and it means the benchmark isn't hiding the ball. The 43% is specific to this scenario mix, which deliberately includes hard oblique probes like "add `<package>`" where the task shares no keyword with the stored rule. It is not a universal recall rate.

### Retrieval work since the frozen benchmark

Separate from the held-out run, a targeted deterministic retrieval eval (no model calls; it drives the real retrieval pipeline over the oblique probes that caused the misses) moved delivery recall from **40% to 100%** with the false-positive rate staying at **0%**. A small 8-trial Claude confirmation then showed behavior follows the newly delivered context (adherence 2/4 control to 4/4 goatedcontext on those cases).

This is a targeted regression eval, not a new held-out benchmark. It does not mean the 76% held-out score is now higher; that number stays frozen. It means the recall gap the benchmark identified has a fix with a regression test behind it.

### Autonomous save, tested

Autonomous saving is newer and the evidence is smaller, so here it is plainly. In a 24-turn behavioral evaluation across 2 real continuing sessions on `claude-sonnet-4-6`:

- 4/4 durable preferences captured, 4/4 precision (nothing wrong saved)
- 1/2 meaningful signals captured — signal recall is the weak spot; it missed one borderline decision
- 18/18 "should save nothing" turns correct
- 2/2 temporary overrides stayed temporary
- 0 duplicates, 0 self-feedback writes (it never re-saved context it was just shown), 0 over-saves
- every persisted write used the safe, provenance-required agent surface

Small sample, single model. But over a realistic session the store stayed sparse and correct, which is the design goal.

## The memory model

| Kind | What it is |
|---|---|
| **Preference** | An explicit, durable developer rule or default. These steer the agent. |
| **Signal** | One meaningful engineering decision or piece of evidence ("this project used Supabase"). |
| **Proposal** | An inferred candidate preference, awaiting your approval. |

Two rules make this trustworthy. Signals never become authoritative on their own: three Supabase projects do not turn into "always use Supabase," the agent can only suggest it and a human decides. Proposals are not auto-approved; they steer nothing until you confirm them.

Preferences are defaults, not commandments. "Prefer Firebase" does not mean rewrite an existing Supabase app or override an explicit instruction you just gave. A repo-specific choice or a hard constraint wins for that task, and the preference stays stored for the next one.

## Agents

Native, zero-config integration for three agents. Anything else connects through a universal interface.

| Agent | Runtime context | MCP | `ctx agent` CLI | AGENTS.md |
|---|---|---|---|---|
| Claude Code | yes (prompt hook) | yes | yes | yes |
| Codex | yes (prompt hook) | yes | yes | yes |
| Cursor | static only | yes | yes | yes |
| Any other MCP agent | via MCP | yes | — | — |
| Any other CLI agent | via subprocess | — | yes | yes (`ctx sync`) |

Claude Code and Codex get runtime context at prompt time, a memory skill, and a narrow permission rule so safe memory writes don't prompt every time. Cursor has no reliable prompt-time hook, so it reads repo rules from `AGENTS.md` and gets the MCP server and memory skill. It gets no terminal auto-approve rule, because Cursor's allowlist is raw-prefix matching: allowing `ctx remember` would also allow `ctx remember x && rm -rf /`, which isn't safe to install.

The precise claim: any agent that can use MCP, invoke a subprocess, or read `AGENTS.md` works with goatedcontext without goatedcontext-specific code, and Claude, Codex, and Cursor receive native integration when detected. This is universal compatibility, not a promise that every agent auto-configures itself.

```bash
ctx mcp                                               # stdio MCP server (get_context + memory tools)
ctx agent context --task "set up the backend" --json  # stable JSON envelope for any subprocess-capable agent
ctx sync                                              # static AGENTS.md projection (weakest fallback)
```

## Security and provenance

Concise but serious. Details in [ARCHITECTURE.md](./ARCHITECTURE.md#persistent-memory-injection-boundary-037).

- **Only user-authored durable intent can become authoritative preference memory.** Repo files, tool output, web content, and model text may influence the current task, but cannot become authoritative user memory through the safe agent surface. A README that says "save this preference" is refused.
- **Explicit origin, fail-closed.** Agent writes go through `ctx agent remember|propose|signal add`, which require an `--origin` and fail without it. The bare `ctx remember` you'd type yourself is not auto-approved, so an agent can't silently persist something it read in a repo file.
- **No recursive re-saving.** Context that goatedcontext injected is not saved back into memory.
- **Local only.** The store is a SQLite file under `~/.ctx`. No server, no account, no network calls, no telemetry.
- **Secrets stay out of the store.** They live in a separate encrypted store (DPAPI on Windows, otherwise an encrypted file) and are never returned through retrieval, context injection, history, stats, or exports. No plaintext secrets on disk.
- Setup never uses `--dangerously-skip-permissions` (Claude) or Full Access (Codex), and never whitelists a shell. Both hosts match the allow rule on split tokens, so chaining another command onto an allowed `ctx` prefix is not auto-approved.

Honest boundary: the model still semantically classifies whether something came from you. This stops accidental and source-confused writes; it is not a cryptographic attestation that a human authored a given string. It is not audited.

## Commands

You normally don't touch these — the agent does — but they're here for inspection and control.

**Memory**
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

**Transfer and debug**
```bash
ctx export
ctx import
ctx test-hook --agent codex --task "..."   # inspect what an agent would receive
```

Conditions (`--when`) support `language=`, `file=`, `domain=`, `repo=`, repeatable for AND. Agents write through a separate, provenance-required surface (`ctx agent remember`, `ctx agent propose`, `ctx agent signal add`, each needing `--origin`); you don't type those. Full command set is in `ctx --help`.

## Benchmarks

The effectiveness benchmark lives in [`benchmarks/developer-memory/`](benchmarks/developer-memory/). It measures behavior, not recall: state a preference, do unrelated work or start a fresh session, then check whether the agent naturally does the preferred thing.

- Frozen dataset (`developer-memory-v1.1`, dataset-hash recorded in each run's `manifest.json`)
- Held-out split, separate from the dev split used for product fixes, so overfitting is visible
- Pinned model (`claude-sonnet-4-6`), seed 1234, 5 trials per cell, 320 trials
- Raw transcripts, trial records, and failure artifacts preserved; the headline [REPORT.md](benchmarks/results/heldout-v1_1-sonnet46/REPORT.md) is recomputed from them (re-scoring produced zero verdict changes)

The autonomous read and save passes have their own reports under [`benchmarks/autonomous-pull/`](benchmarks/autonomous-pull/) and [`benchmarks/autonomous-save/`](benchmarks/autonomous-save/).

Separately, local retrieval overhead (no model inference, just the lookup), measured on the dev machine with `bun run bench` — ballpark, not a guarantee:

| What | Result |
|---|---|
| Preference retrieval, 1k active preferences | ~17 ms (warm median) |
| Signal-aware retrieval, 50k signal rows | ~26 ms (warm median) |
| Decision-aware write vs plain write | +~0.1 ms per write |
| Cold `ctx --version` (full Node process) | ~60 ms |

A realistic store has tens to hundreds of preferences, where retrieval is a few milliseconds; the 1k/50k figures are stress tests.

## Limitations

- **Retrieval recall is the active problem.** On the frozen held-out split, delivery capped the result at 43%. The targeted eval above fixes the identified oblique-probe cases, but recall on unusual phrasing remains an engineering problem, not a solved one.
- **Autonomous-save tests are still small** (a 24-turn session, single model). Signal recall specifically was 1/2.
- **Provenance is semantic, not cryptographic.** The model classifies whether content came from you; that is not human attestation.
- **Cursor is weaker.** No runtime injection path and no safe auto-approve rule, so it relies on static `AGENTS.md`. Its autonomous behavior isn't benchmarked.
- **No semantic/vector retrieval backend and no cloud sync.** Preference retrieval cost grows with the number of active preferences.
- A managed/enterprise agent policy can override the locally installed permission rules.
- Historical signal reasons ("Firebase free tier was too small") can go stale; they're treated as past evidence, not current fact.

## Development

Bun for development and tests; the published CLI runs on Node ≥ 22.13 using Node's built-in `node:sqlite` — no native addon, no compiler toolchain.

```bash
git clone https://github.com/razzyshmazzy/goatedcontext
cd goatedcontext
bun install
bun run typecheck
bun test
bun run build
```

CI runs typecheck, build, and the test suite on Linux, macOS, and Windows, plus the built CLI on plain Node. Design details are in [ARCHITECTURE.md](./ARCHITECTURE.md); release process in [RELEASE.md](./RELEASE.md).

## License

MIT.

> "You know what's funny? GOATS!" — Goat Simulator

If goatedcontext saves you from repeating yourself, a star helps other people find it.
