/**
 * THE canonical goatedcontext "memory protocol".
 *
 * Supported agents must not merely READ ctx — they must know when to WRITE durable
 * developer preferences back, so the user never has to run `ctx remember/propose/
 * forget` by hand. This file is the SINGLE source of that behavioral policy. Every
 * agent adapter (Claude skill, Codex SKILL.md, Cursor skill/rule) renders the SAME
 * body from here; only the host-required frontmatter wrapper differs. Parity tests
 * assert the body is byte-identical across all three.
 *
 * This is instruction text, not code: the agent already understands natural
 * language; the protocol tells it WHEN to call the deterministic `ctx` commands.
 * There is NO background daemon, LLM, scraper, or embedding here (and there must
 * never be) — see the 0.2.10 spec §26.
 */

/**
 * Bump when the body below changes in a way installers must re-sync. Adapters store
 * this marker in the rendered artifact so `ctx doctor` can flag a STALE skill (an
 * old installed body) and `ctx repair` can converge it.
 */
export const MEMORY_PROTOCOL_VERSION = "1";

/** Hidden marker embedded in every rendered artifact for staleness detection. */
export const MEMORY_PROTOCOL_MARKER = `<!-- ctx-memory-protocol: v${MEMORY_PROTOCOL_VERSION} -->`;

/**
 * The canonical protocol body (identical for every agent). Starts at the top-level
 * heading; the host wrapper supplies frontmatter above it.
 */
export const MEMORY_PROTOCOL_BODY = `# goatedcontext memory protocol

\`goatedcontext\` (the \`ctx\` CLI) is the developer's persistent context store. You
already RECEIVE relevant preferences automatically. This skill tells you when to
WRITE durable preferences back, so the developer never has to run \`ctx\` by hand.
Use the \`ctx\` CLI for every memory operation — never edit \`~/.ctx\`, the SQLite
database, or \`AGENTS.md\` directly, and prefer \`--json\` output when you parse.

## 1. Durable preference → persist with \`ctx remember\`

When the developer clearly states a lasting preference, persist it. Judge INTENT,
not keywords, but these words usually signal persistence: always, never, from now
on, going forward, remember, prefer, usually, in this repo/project, whenever,
every time, my default.

Persist (examples):
- "Always use Bun in this repo."
- "From now on use tabs."
- "I never want dependencies added without asking."
- "For this project, use PostgreSQL."
- "Remember that I prefer concise explanations."

Command (run it; do not make the user run it, and do not ask for redundant
confirmation when the wording is explicit):

    ctx remember --scope <global|repo> [--always | --when <key=value> ...] "<one terse rule>"

### Scope — choose conservatively; when ambiguous, prefer repo
- repo: the developer refers to "this repo/project/codebase/app", "here", or
  project-specific tooling/conventions.
    "Always use Bun in this repo." -> --scope repo
    "This project uses pnpm."      -> --scope repo
- global: clearly cross-project / personal.
    "Always answer me concisely."                 -> --scope global
    "I prefer Zod in all my TypeScript projects." -> --scope global
Never silently turn a local convention into a global rule.

### Applicability — pick when obvious
- --always: a genuinely universal/static directive.
    "Always use Bun in this repo." / "Never add dependencies without asking."
- --when <key=value>: an explicit deterministic condition (repeat to AND).
    "When editing TypeScript, use strict types."  -> --when language=typescript
    "For .tsx files, use functional components."   -> --when file=**/*.tsx
    "For database work, use foreign keys."         -> --when domain=database
- default (relevant): durable, but should surface only when semantically relevant.
    "I prefer Postgres for relational data." / "Prefer simple architectures."
Do NOT force every preference into --always.

## 2. Inferred preference → \`ctx propose\`, never \`ctx remember\`

If the developer did NOT explicitly state a durable preference but you notice a
likely recurring one from behavior (e.g. they keep switching npm -> Bun across
turns), propose it instead of persisting it:

    ctx propose --evidence "<what you observed>" "<the rule>"

A single isolated request is NOT evidence — persist nothing. Proposals are silent;
do not interrupt the task to ask "should I remember this?".

## 3. One-off task instruction → store NOTHING

Task-local directives are not durable preferences unless the developer clearly
signals persistence. Never persist these:
- "Use Python for this script." / "Don't add a package for this task."
- "Make this function async." / "Use red for this button."
- "For this one migration, avoid triggers."
Interpret intent conservatively; never use keyword-only logic.

## 4. Retraction / correction → \`ctx forget\` (or replace)

"Stop using Bun in this repo." / "Forget that I prefer Postgres." / "Actually use
npm from now on." / "Don't remember that anymore."

Find the matching preference, then remove or replace it:

    ctx prefs --json
    ctx why <id> --json
    ctx forget <id>

When the developer replaces a preference, persist the replacement — ctx's existing
conflict/precedence semantics reconcile it; don't leave an obvious contradictory
stale rule behind. If several preferences plausibly match and deletion is
ambiguous, ask ONE concise clarification. Never guess which unrelated memory to
delete.

## 5. NEVER preference-store secrets or task data

Never put into preferences: passwords, API keys, tokens, private keys,
credentials, or secret environment values — nor source code, private file
contents, customer data, or large task context. Preferences describe durable
developer BEHAVIOR and context. Secret VALUES belong only in \`ctx env\`.

## 6. Be invisible, and never block the task

- Persist, then continue the work. A brief natural acknowledgement is fine; do NOT
  narrate the command ("I ran ctx remember ...") unless the developer asks, it
  fails, or it materially affects what they need to know. It should feel like
  memory, not CLI orchestration.
- Allowed memory operations: \`ctx remember\`, \`ctx propose\`, \`ctx forget\`,
  \`ctx prefs\`, \`ctx why\`. Pass \`--agent-id\`/\`--session-id\` when your host
  exposes a session id. Nothing else mutates ctx.
- If \`ctx\` is unavailable or a write fails: do NOT fail the developer's task and
  do NOT retry in a loop. If the preference was explicit, mention briefly at the
  end — "I followed that preference here, but couldn't persist it to ctx." — with
  no stack traces or implementation noise.

${MEMORY_PROTOCOL_MARKER}`;

/** Shared one-line description (hosts may tweak only trivially in their frontmatter). */
export const MEMORY_PROTOCOL_DESCRIPTION =
  "Persist, update, and retract the developer's durable coding preferences in goatedcontext (ctx). Use whenever the developer states, changes, or revokes a lasting preference or project convention (e.g. \"always use Bun in this repo\", \"from now on use tabs\", \"forget that I prefer Postgres\") so it follows them across repos and reaches every agent — without them running ctx by hand.";

/** The POSIX ctx launcher name. */
export const CTX_COMMAND_POSIX = "ctx";
/**
 * The Windows ctx launcher name. On Windows, bare `ctx` resolves to npm's generated
 * PowerShell shim (`ctx.ps1`), which PowerShell refuses to run under the default
 * execution policy. The `.cmd` shim always runs (PowerShell, cmd, and Git Bash), so
 * agents on Windows must invoke `ctx.cmd` — without the user weakening their policy.
 */
export const CTX_COMMAND_WINDOWS = "ctx.cmd";

/**
 * The ctx launcher name an agent should invoke on a given platform. Only the command
 * SPELLING differs by platform — the semantic memory policy is identical everywhere.
 */
export function ctxCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? CTX_COMMAND_WINDOWS : CTX_COMMAND_POSIX;
}

/**
 * A small, platform-specific invocation note inserted just above the policy body
 * when the command is not the default `ctx` (i.e. on Windows). The canonical policy
 * below still reads `ctx …`; this note tells the agent how to actually invoke it on
 * this host. Returns "" for the default `ctx`, so POSIX renders are byte-identical to
 * the platform-blind canonical body (keeping cross-agent parity exact).
 */
function platformInvocationSection(command: string): string {
  if (command === CTX_COMMAND_POSIX) return "";
  return `## Invocation on this platform (Windows)

This machine is Windows. Invoke ctx as \`${command}\` for **every** command below —
plain \`ctx\` resolves to the npm-generated \`ctx.ps1\` shim, which PowerShell blocks
under its default execution policy. Use \`${command} remember …\`, \`${command} propose …\`,
\`${command} prefs …\`, \`${command} why …\`, and \`${command} forget …\`. Do not ask the
developer to change their PowerShell execution policy. (On macOS/Linux the command is
plain \`ctx\`.)

`;
}

/** The canonical body with the platform invocation note applied for `command`. */
export function renderProtocolBody(command: string = CTX_COMMAND_POSIX): string {
  const section = platformInvocationSection(command);
  if (!section) return MEMORY_PROTOCOL_BODY;
  // Insert the note just before section 1, so it's the first thing read after the
  // intro. The canonical policy text itself is never rewritten.
  const marker = "## 1. Durable preference";
  const idx = MEMORY_PROTOCOL_BODY.indexOf(marker);
  if (idx === -1) return section + MEMORY_PROTOCOL_BODY; // defensive: never seen
  return MEMORY_PROTOCOL_BODY.slice(0, idx) + section + MEMORY_PROTOCOL_BODY.slice(idx);
}

/**
 * Render a SKILL.md-style artifact (YAML frontmatter + the canonical body). Used by
 * the Claude and Codex adapters (same format); Cursor supplies its own wrapper.
 *
 * `command` selects the ctx launcher spelling the guidance should use (default
 * `ctx`; pass `ctx.cmd` on Windows). The semantic policy is identical regardless.
 */
export function renderSkillMd(opts: { name: string; description?: string; command?: string }): string {
  const description = (opts.description ?? MEMORY_PROTOCOL_DESCRIPTION).trim();
  const body = renderProtocolBody(opts.command ?? CTX_COMMAND_POSIX);
  return `---\nname: ${opts.name}\ndescription: >-\n  ${description}\n---\n\n${body}\n`;
}

/** Extract the canonical body from a rendered artifact (strips any leading frontmatter). */
export function extractProtocolBody(rendered: string): string {
  const fm = rendered.match(/^---\n[\s\S]*?\n---\n+/);
  const body = fm ? rendered.slice(fm[0].length) : rendered;
  return body.trim();
}

/**
 * The skill NAME (and therefore folder name — Codex/Cursor require they match) for
 * the standalone memory skill installed into Codex and Cursor. Claude's adapter
 * renders the same body under its existing `context-learn` skill instead of adding
 * a new one.
 */
export const CTX_MEMORY_SKILL_NAME = "goatedcontext";

/**
 * The rendered SKILL.md shared by the Codex and Cursor memory-skill installers.
 * `command` selects the ctx launcher spelling (default `ctx`; `ctx.cmd` on Windows).
 */
export function renderMemorySkill(opts: { command?: string } = {}): string {
  return renderSkillMd({ name: CTX_MEMORY_SKILL_NAME, command: opts.command });
}
