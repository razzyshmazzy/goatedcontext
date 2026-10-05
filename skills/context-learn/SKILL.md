---
name: context-learn
description: >-
  Persist, update, or retract the developer's DURABLE coding preferences in goatedcontext (ctx). Use the moment they state, change, or revoke a lasting preference or project convention — e.g. "always use Bun in this repo", "from now on use tabs", "use Svelte in this project", "forget that I prefer Postgres". Run one `ctx remember` for an explicit preference (one-off task instructions are NOT stored) so it follows them across repos and every agent, without them running ctx by hand.
---

# goatedcontext memory protocol

`goatedcontext` (the `ctx` CLI) is the developer's persistent context store. You
already RECEIVE relevant preferences automatically; this skill is for WRITING them
back so the developer never runs `ctx` by hand. Use the CLI for every memory
operation — never edit `~/.ctx`, the SQLite database, or `AGENTS.md` by hand.

For an explicit, unambiguous preference the fastest path is best: pick scope +
applicability and run exactly ONE `ctx remember`. Do NOT first run `ctx prefs`,
`ctx why`, or any inspection for a straightforward new write, and do not narrate
tool selection — just persist and continue the task.

## 1. Durable preference → `ctx remember`

Persist when the developer states a LASTING preference. Judge INTENT, not keywords;
signals: always, never, from now on, remember, prefer, usually, in this repo. Run it
yourself; do not ask for redundant confirmation when the wording is explicit:

    ctx remember --scope <global|repo> [--always | --when <key=value> ...] "<one terse rule>"

### Scope — choose conservatively; when ambiguous, prefer repo
- repo: "this repo/project/codebase/app", "here", or project-specific tooling.
    "Always use Bun in this repo." -> --scope repo
- global: clearly cross-project / personal.
    "I prefer Zod in all my TypeScript projects." -> --scope global
Never silently turn a local convention into a global rule.

### Applicability
- --always: a universal/static directive — "Never add dependencies without asking."
- --when <key=value>: an explicit condition, repeat to AND —
  --when language=typescript, --when file=**/*.tsx, --when domain=database.
- default (relevant): durable, surfaced only when relevant — "I prefer Postgres for relational data."
Do NOT force every preference into --always.

### Acknowledge only the scope you actually wrote
The command echoes the scope it persisted (`scope=...`); that result is
authoritative — never claim a broader reach than you wrote. Acknowledge in one
short line that matches it:
- repo -> "Saved for this repository." / "I'll use it in this project."
- global -> "Saved as your general preference." / "I'll use this across your projects."
- conditional -> name the condition — "Saved for TypeScript work."
With `--scope repo`, never say "for future projects", "across projects" /
"across repositories", or "as your general default".

## 2. Inferred preference → `ctx propose`, never `ctx remember`

If the developer did NOT state a durable preference but you notice a likely
recurring one from behavior, propose it instead of persisting it:

    ctx propose --evidence "<what you observed>" "<the rule>"

A single isolated request is NOT evidence — persist nothing. Proposals are silent.

## 3. One-off task instruction → store NOTHING

Task-local directives are not durable preferences — store NOTHING:
"Use Python for this script.", "Make this function async.", "Use red for this button."
Interpret intent conservatively; never use keyword-only logic.

## 4. Retraction / correction → `ctx forget` (or replace)

"Stop using Bun in this repo." / "Forget that I prefer Postgres." / "Actually use
npm from now on." Find the matching preference, then remove or replace it
(a replacement is persisted — ctx's conflict/precedence reconciles it):

    ctx prefs --json
    ctx why <id> --json
    ctx forget <id>

If several preferences plausibly match, ask ONE concise clarification before acting.
Never guess which unrelated memory to delete.

## 5. NEVER preference-store secrets or task data

Never persist passwords, API keys, tokens, private keys, credentials, or secret
environment values — nor source code, private file contents, customer data, or
large task context. Secret VALUES belong only in `ctx env`.

## 6. Be invisible, and never block the task

- Persist, then continue, but do NOT narrate the command ("I ran ctx remember ...")
  unless the developer asks or it fails. A brief acknowledgement (see §1) is fine; it
  should feel like memory, not CLI orchestration.
- Allowed memory operations: `ctx remember`, `ctx propose`, `ctx forget`,
  `ctx prefs`, `ctx why`. Pass `--agent-id`/`--session-id` when your host
  exposes one. Nothing else mutates ctx.
- If `ctx` is unavailable or a write fails: do NOT fail the developer's task and do
  NOT retry in a loop. If the preference was explicit, mention briefly at the end —
  "I followed that preference here, but couldn't persist it to ctx." — no stack traces.

<!-- ctx-memory-protocol: v1 -->
