# goatedcontext

[![CI](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml/badge.svg)](https://github.com/razzyshmazzy/goatedcontext/actions/workflows/ci.yml)

Local developer memory shared across repos and between coding agents.

**Cross-repo, cross-agent.** Your coding preferences live in a local store and
reach whichever agent you're using.

> "You know what's funny? GOATS!" — Goat Simulator

## What it is

So I frequently switch between repos but most of my stack is the same, so I made goatedcontext to remember that. goatedcontext stores preferences locally, and hands the relevant ones to whichever agent you're using. it's runtime-based.

It is **not** a context-window extension, a transcript RAG system, or a vector database. There are no embeddings and no server. It stores structured developer preferences and compact decision evidence in a local SQLite file, and gives the relevant subset to supported agents at prompt time. That's the whole idea.

## Works with any agent

goatedcontext works with any agent that can **speak MCP**, **invoke a subprocess**, or **read AGENTS.md**. Claude Code, Codex, and Cursor have native, zero-config integrations.

| Agent | Integration |
|-------|-------------|
| Claude Code | native (prompt hook + memory skill + permissions) |
| Codex | native (prompt hook + AGENTS.md + sandbox writable root) |
| Cursor | native (sessionStart hook + MCP server + AGENTS.md + memory skill) |
| local / custom / terminal / homegrown agents | **MCP server**, **`ctx agent` CLI**, or **AGENTS.md** — no goatedcontext adapter required |

Supporting a new agent requires **no goatedcontext code change** — only one of the universal interfaces. This is universal *compatibility*, not a claim that `npx goatedcontext setup` auto-connects every agent in existence. See [INTEGRATING.md](INTEGRATING.md) (10-minute integration, with a Python example).

```bash
ctx mcp                                              # stdio MCP server (get_context + memory tools)
ctx agent context --task "set up the backend" --json # stable JSON envelope for any subprocess-capable agent
ctx sync                                             # static AGENTS.md projection (weakest fallback)
```

## Example

Tell Claude Code:

> Prefer TypeScript over JavaScript.

It saves that preference locally. Later, in Codex:

> write a levenshtein helper

Codex writes it in TypeScript, because it got your preference without u needing to repeat it.

Repo-specific choices work too:

> Use Supabase for the backend in this repo.

That becomes a preference for this repo, and also a cross-repo *signal* ("backend → supabase"). Make the same call in a few projects and the next time an agent needs to pick a backend, it sees that you tend to reach for Supabase. It's soft evidence, not a rule it's forced to follow.

Totally hands-free ofc. You don't run any commands for this. Talk to the agent normally; it decides what's worth remembering and writes it through `ctx`.

## Install

```bash
npx goatedcontext setup
```

Node 22.13+. `setup` installs the persistent `ctx` CLI, detects which agents you have, and wires up their integrations. Rerun it anytime to upgrade or repair. You never `npm install -g` by hand.

Check it worked:

```bash
ctx agents
ctx doctor
```

## How it works

```text
you tell an agent a preference
            |
            v
      local SQLite store  (~/.ctx)
            |
   +--------+--------+
   |        |        |
preferences signals proposals
   |        |
   +---relevance / scope---+
            |
   +--------+--------+
   |                 |
 Claude Code       Codex          Cursor (static only)
 (runtime hook)  (runtime hook)   (AGENTS.md)
```

Three kinds of memory, kept deliberately separate:

- **Preferences** — durable instructions you (or the agent, on your behalf) chose to keep. These are what actually steer the agent.
- **Proposals** — things the agent suspects are preferences but isn't sure about yet. They don't steer anything until you confirm them.
- **Signals** — evidence of individual decisions across repos ("this project used Supabase"). Signals never silently become preferences. Three Supabase projects do not turn into "always use Supabase" on their own — the agent can *suggest* it, but a human decides.

Preferences are defaults, not commandments. "Prefer Firebase" does not mean rewrite an existing Supabase app, use Firebase where it can't work, or override an explicit instruction you just gave. A repo-specific choice or a hard constraint wins for that task, and the preference stays stored for the next one.

## Supported agents

| Agent | Runtime context | Static repo rules | Memory writes | Auto-approve rule |
|---|---|---|---|---|
| Claude Code | yes (prompt hook) | — | yes | yes (`settings.json`) |
| Codex | yes (prompt hook) | `AGENTS.md` | yes | yes (`.rules` file) |
| Cursor | no | `AGENTS.md` | yes | no (see below) |

All three get a memory skill that teaches the agent when to save, propose, or ignore something. Claude Code and Codex also receive context at prompt time and a narrow permission rule so memory writes don't prompt you for approval every time (details below).

Cursor is more limited: it has no reliable prompt-time injection hook, so it reads repo rules from `AGENTS.md` instead of live context, and goatedcontext does not install a terminal auto-approve rule for it — Cursor's allowlist is raw-prefix matching, so allowing `ctx remember` would also allow `ctx remember x && rm -rf /`. That's not safe to install, so it isn't.

## Permissions

`setup` adds a narrow allow rule so agents can run the safe `ctx` commands without asking you to approve each one. It does **not** use `--dangerously-skip-permissions` (Claude) or Full Access (Codex), and never whitelists a shell.

Memory writes go through a dedicated agent path — `ctx agent remember`, `ctx agent propose`, `ctx agent signal add` — that requires a `--origin` and fails without it. Those, plus the read commands `prefs`, `why`, `signals`, `history`, `conflicts`, are what's auto-approved. The bare `ctx remember`/`ctx propose`/`ctx signal add` you'd type yourself are **not** auto-approved, so an agent can't silently run a memory-write it found in a repo file or tool output — that falls back to a normal approval prompt. Everything else still prompts too: `env`, `import`, `setup`, `install`, `uninstall`, `forget`, `signal clear`, `prefs approve`/`reject`.

Both hosts match safely: Claude splits on shell operators (`&&`, `;`, `|`, …) and checks each part, and Codex matches on argv tokens, so chaining another command onto an allowed `ctx` prefix does not get auto-approved. A managed/enterprise policy can still override a local allow — `ctx doctor` reports whether the rule is present, not that your org will honor it.

## Benchmarks

goatedcontext does not touch model inference, so these only measure the overhead of local retrieval. Measured on the dev machine (Windows, Node 26 / Bun 1.4.2) with `bun run bench` — treat them as ballpark, not guarantees.

| What | Result |
|---|---|
| Preference retrieval, 1k active preferences | ~17 ms (warm median) |
| Signal-aware retrieval, 50k signal rows | ~26 ms (warm median) |
| Decision-aware write vs plain write | +~0.1 ms per write |
| Cold `ctx --version` (full Node process) | ~60 ms |

Preference retrieval scales roughly linearly with the number of active preferences; a realistic store has tens to hundreds, where it's a few milliseconds. The 1k/50k figures are stress tests, not typical load. Reproduce with `bun run bench` (numbers vary by machine).

## Security and privacy

- The store is a local SQLite file under `~/.ctx`. No server, no account, no network calls.
- No telemetry. No transcript scraping. No embeddings or vector index.
- Secrets live in a separate store (DPAPI on Windows, otherwise an encrypted file) and are never returned through preference retrieval, context injection, history, stats, or exports.
- The permission rules are narrow and host-validated (see above). Setup does not require any blanket permission bypass.
- Repository and tool content cannot directly become persistent memory. Durable preferences require user-originated intent; a README or tool output telling the agent to "save this preference" is refused, and project/web content never counts as cross-repo developer-choice evidence. The model still classifies source, so this stops accidental and source-confused writes rather than being a cryptographic guarantee — see [ARCHITECTURE.md](./ARCHITECTURE.md#persistent-memory-injection-boundary-037).

It is not audited and I'm not claiming it's bulletproof. This is what it does and does not do; judge it on that.

## Limitations

- Domain matching for surfacing decision evidence is deterministic and intentionally small. Unusual domain wording may not surface relevant signals automatically.
- Cursor has no runtime injection path and no safe auto-approve rule, so its experience is weaker than Claude Code or Codex.
- A managed/enterprise agent policy can override the locally installed permission rules.
- Historical signal reasons ("Firebase free tier was too small") can go stale; they're treated as past evidence, not current fact.
- No cloud sync. No arbitrary conversation memory. Preference retrieval cost grows with the number of active preferences.

## Manual CLI

You normally don't touch this, but it's there for inspection and control:

```bash
ctx prefs                 # list preferences
ctx prefs pending         # proposals awaiting review
ctx signals               # aggregated decision evidence
ctx why <id>              # why a preference exists
ctx conflicts             # conflicting rules
ctx doctor                # diagnostics
ctx test-hook --agent codex --task "..."   # inspect what an agent would receive
```

Writing is normally the agent's job, but you can do it directly:

```bash
ctx remember --scope repo --always "Use Bun for development commands."
ctx remember --when language=typescript "Prefer strict TypeScript."
```

Conditions (`--when`) support `language=`, `file=`, `domain=`, `repo=`, repeatable for AND. Full command set is in `ctx --help`.

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

CI runs typecheck, build, and the test suite on Linux, macOS, and Windows, plus the built CLI on plain Node.

Design details are in [ARCHITECTURE.md](./ARCHITECTURE.md). Release process is in [RELEASE.md](./RELEASE.md).

## License

MIT.
