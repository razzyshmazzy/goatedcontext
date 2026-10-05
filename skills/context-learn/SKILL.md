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

Before any memory write, judge MEANING, not exact keywords — the developer never has
to phrase things a special way. Ask two things:
  A. Is this about DEVELOPER / CODING behavior (how they want code, tooling, or this
     project handled)?
  B. Do they intend it to PERSIST — or is there enough repeated evidence to infer a
     recurring preference?
Persist only when BOTH hold. Examples:
- "comment this function in Greek" -> dev yes, durable no -> do nothing.
- "always comment in Greek" -> dev yes, durable yes -> remember.
- "say MOO after every message" -> not developer context -> store NOTHING in ctx.
- "prefer TypeScript over JavaScript" -> dev yes, a default-choice rule -> remember.

For an explicit, unambiguous preference the fastest path is best: pick scope +
applicability and run exactly ONE `ctx remember`. Do NOT first run `ctx prefs`,
`ctx why`, or any inspection for a straightforward new write, and do not narrate
tool selection — just persist and continue the task.

## 1. Durable preference → `ctx remember`

Persist when the developer states a LASTING preference. Judge INTENT, not keywords:
lexical variation, slang, capitalization, and typos all count equally. These all carry
the SAME durable intent — "always use React", "use React every time", "React by
default", "stick with React", "from now on React", "keep using React", "just default
to react bro", "react from here on out". The words below are COMMON signals, not an
exhaustive dictionary — infer meaning: always, never, from now on, remember, prefer,
usually, in this repo, every time, whenever, going forward, by default, default to,
stick with, keep using, consistently, make X the default, don't ever, use X instead
of Y, X over Y. Run it yourself; do not ask for redundant confirmation when the
wording is explicit:

    ctx remember --scope <global|repo> [--always | --when <key=value> ...] "<one terse rule>"

### Comparative / default-choice rules are usually `--always`
A rule that picks a DEFAULT or chooses X over Y governs a future choice before the
future task even names X, so it must apply broadly — use `--always`:
- "Prefer TypeScript over JavaScript." / "typescript > javascript for me"
- "Use Bun instead of npm." / "Default to React for frontend work."
Later "code a Levenshtein function for my web app" must still pick TypeScript even
though the prompt never says "TypeScript". But distinguish a DECISION RULE from a mere
OPINION: "I like TypeScript's type system" is just relevant context, not a default —
do not make it `--always`.

### Scope — choose conservatively; when ambiguous, prefer repo
- repo: "this repo/project/codebase/app", "here", or project-specific tooling.
    "Always use Bun in this repo." -> --scope repo
    "Keep using React for this project." -> --scope repo --always
- global: clearly cross-project / personal.
    "I prefer Zod in all my TypeScript projects." -> --scope global
Never silently turn a local convention into a global rule.

### Applicability
- --always: a universal/static directive or a default-choice rule —
  "Never add dependencies without asking."
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

### Reinforcement follow-ups — strengthen, don't duplicate
A short follow-up emphasizing permanence refers to the preference you just saved, even
when it does not restate the subject: "like ALWAYS", "no, I mean every single time",
"I mean as the default", "yes, permanently", "for all future work here". The current
conversation is legitimate evidence. If the existing preference is already at that
scope + applicability (e.g. repo + always), make NO write — just acknowledge briefly.
Do not create a duplicate preference. If it was weaker, upgrade/replace it (persist the
stronger version; ctx's conflict/precedence reconciles it).

## 2. Inferred preference → `ctx propose`, never `ctx remember`

If the developer did NOT state a durable preference but you notice a likely recurring
one — the same choice at several independent decision points, or them correcting the
same default repeatedly — propose it instead of persisting it:

    ctx propose --evidence "<what you observed>" "<the rule>"

Use judgment, NOT a counter: there is no fixed number of repetitions. One repeated
request can be strong evidence; five can be weak if they are all consequences of one
local task. A single isolated request is NOT evidence — persist nothing. Proposals are
silent. Example: repeated "comment this in Greek" across distinct edits may warrant
`ctx propose "Prefer comments in Greek."` — never `ctx remember`, because the
developer never said it should be durable.

## 3. One-off task instruction → store NOTHING

A task-local directive is not a durable preference — store NOTHING:
"Use Python for this script.", "Make this function async.", "Use red for this button."
Interpret intent conservatively; never use keyword-only logic. If it is nonetheless a
meaningful, repeatable development CHOICE (which backend/framework/database you picked),
you MAY record a compact signal as evidence (see §4) — but still write no preference.

## 4. Signals — evidence of decisions, NOT instructions

A signal is a compact record of a development choice (domain + choice) that is NOT yet
a durable preference. It is EVIDENCE, not an instruction: a signal never changes your
behavior on its own, and ctx NEVER promotes one to a preference automatically. Record
one in a single cheap command when the developer makes a meaningful decision that was
not stated as durable:

    ctx signal add --domain <domain> --choice <choice>

e.g. `--domain backend --choice supabase`, `--domain package-manager --choice bun`,
`--domain comment-language --choice greek`. Record only meaningful DECISIONS (backend,
framework, database, package manager, language, testing, styling, architecture) — never
routine activity (files opened, functions written, commands run).

To judge whether a pattern is worth proposing, read the aggregated evidence:

    ctx signals --domain <domain>
    ctx signals --json

Breadth beats raw count: the same choice in several DISTINCT repositories is far
stronger evidence of a global default than many hits inside one repo. Decide by YOUR
judgment — there is NO automatic threshold:
- broad and consistent, no contradictions -> `ctx propose` (e.g. "Prefer Supabase for
  backend work."); repeated only inside one repo -> a REPO proposal, not global.
- contradictory evidence (Supabase in one repo, Firebase in another) -> propose
  nothing; there is no stable default yet — do not hide the minority choice.
Signals are evidence ONLY: an explicit approved/locked preference always wins over
them. Never surface raw signal history to the user unprompted.

## 5. Retraction / correction → `ctx forget` (or replace)

"Stop using Bun in this repo." / "Forget that I prefer Postgres." / "Actually use
npm from now on." Find the matching preference, then remove or replace it
(a replacement is persisted — ctx's conflict/precedence reconciles it):

    ctx prefs --json
    ctx why <id> --json
    ctx forget <id>

If several preferences plausibly match, ask ONE concise clarification before acting.
Never guess which unrelated memory to delete.

## 6. NEVER preference-store secrets or task data

Never persist passwords, API keys, tokens, private keys, credentials, or secret
environment values — nor source code, private file contents, customer data, or large
task context, in preferences OR signals. Secret VALUES belong only in `ctx env`.

## 7. Be invisible, and never block the task

- Persist (or record a signal), then continue, but do NOT narrate the command ("I ran
  ctx remember ..." / "recording a signal ...") unless the developer asks or it fails.
  It should feel like memory, not CLI orchestration; a brief acknowledgement (see §1)
  is fine. Signals are invisible infrastructure.
- Allowed memory operations: `ctx remember`, `ctx propose`, `ctx forget`,
  `ctx prefs`, `ctx why`, `ctx signal add`, `ctx signals`. Pass
  `--agent-id`/`--session-id` when your host exposes one. Nothing else mutates ctx.
- If `ctx` is unavailable or a write fails: do NOT fail the developer's task and do
  NOT retry in a loop. If the preference was explicit, mention briefly at the end —
  "I followed that preference here, but couldn't persist it to ctx." — no stack traces.

<!-- ctx-memory-protocol: v2 -->
