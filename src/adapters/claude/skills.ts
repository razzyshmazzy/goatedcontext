/**
 * Canonical Claude Code skill definitions. These are the single source of truth:
 * both `ctx install claude` and the committed `skills/**\/SKILL.md` files are
 * generated from these constants. The skills are thin — they instruct Claude to
 * call the `ctx` CLI and never re-implement any engine logic.
 *
 * The `context-learn` skill's body is rendered from the ONE canonical ctx-memory
 * protocol in `core/assets/memory-protocol.ts`, shared verbatim with the Codex and
 * Cursor skills, so all agents learn the identical remember/propose/forget policy.
 */
import { renderSkillMd } from "../../core/assets/memory-protocol.ts";
import { renderPullGuidance } from "../../core/assets/retrieval-policy.ts";
import { SAVE_POLICY_CORE } from "../../core/assets/save-policy.ts";

/** Claude's concrete read-only pull invocation (the CLI `ctx get`). */
const CLAUDE_PULL_ACTION = 'run `ctx get --cwd "$PWD" --task "<concise task>"`';

export interface SkillDefinition {
  /** Directory name under the Claude skills folder. */
  dir: string;
  /** Full SKILL.md contents. */
  content: string;
}

const CONTEXT_SKILL = `---
name: context
description: >-
  Retrieve the developer's persistent preferences and available environments
  before making consequential engineering decisions (architecture, dependencies,
  data modeling, infrastructure, security, testing strategy, or other significant
  implementation choices). Backed by the local \`ctx\` CLI.
---

# context

Use this skill BEFORE any consequential engineering decision, including:

- architecture and service boundaries
- adding or choosing dependencies
- data modeling and schema design
- infrastructure and deployment choices
- security-sensitive changes
- testing strategy
- other significant implementation choices

## Automatic retrieval (push)

Relevant developer context is often injected for you automatically: a
\`ctx\` prompt hook runs on each user message and, when it finds relevant
preferences, prepends a \`<ctx-developer-context>\` block to the conversation.
When you see that block, it is authoritative — apply it. If a repo preference and
a global preference conflict, the repo preference wins.

## Proactive retrieval (pull)

The push path above catches the obvious cases, but it can miss context for terse or
oblique tasks. So when a decision could depend on established context and it was NOT
already injected this turn, retrieve it yourself:

${renderPullGuidance({ action: CLAUDE_PULL_ACTION })}

\`ctx get\` returns concise JSON (repo, relevance-filtered conflict-resolved
preferences, available environments). Never ask \`ctx\` for secrets — it does not
return them, by design.
`;

const CONTEXT_LEARN_SKILL = renderSkillMd({ name: "context-learn" });

const CONTEXT_ENV_SKILL = `---
name: context-env
description: >-
  Discover and run reusable development environments (e.g. supabase-test,
  stripe-test, openai-dev) via the \`ctx\` CLI. Secrets are injected into the child
  process only and never printed.
---

# context-env

Reusable environments bundle the environment variables (including secret values)
needed to run a task against a service, without exposing those values.

## Discover

\`\`\`bash
ctx env list
ctx get --cwd "$PWD" --task "<task>"   # includes an "environments" section
\`\`\`

The \`available\` flag tells you whether every required secret is present.

## Run a command inside an environment

\`\`\`bash
ctx env run <name> -- <command>
\`\`\`

For example:

\`\`\`bash
ctx env run supabase-test -- npm test
\`\`\`

The child process receives the environment's variables; \`ctx\` never prints the
values. Multiple environments can be composed (later wins on conflicts):

\`\`\`bash
ctx env run supabase-test openai-dev -- npm test
\`\`\`

Multiple \`ctx env run\` invocations are safe to run concurrently; each child gets
its own environment and secrets never leak between them.

### Shell note

In bash/zsh, put the command after \`--\`. In PowerShell, \`--\` is consumed by the
shell, so use \`--exec\` instead:

\`\`\`powershell
ctx env run supabase-test --exec npm test
\`\`\`

## Hard rules

- Never print, echo, or log secret values.
- Never copy secret values into code, preferences, or SKILL files.
- Prefer \`ctx env run\` over reading secrets yourself.
`;

export const CLAUDE_SKILLS: SkillDefinition[] = [
  { dir: "context", content: CONTEXT_SKILL },
  { dir: "context-learn", content: CONTEXT_LEARN_SKILL },
  { dir: "context-env", content: CONTEXT_ENV_SKILL },
];

export const CTX_INSTRUCTION_BEGIN = "<!-- ctx:begin -->";
export const CTX_INSTRUCTION_END = "<!-- ctx:end -->";

/** The idempotent block inserted into the user's global Claude instructions. */
export const CTX_INSTRUCTION_BLOCK = `${CTX_INSTRUCTION_BEGIN}
## Developer Context (ctx)

Persistent developer preferences are retrieved for you automatically.

- A \`ctx\` prompt hook runs on each message and injects a
  \`<ctx-developer-context>\` block containing your always-on preferences (applied
  every turn) plus any preferences relevant to the current task. Treat that block
  as authoritative and apply it before making engineering decisions. Repository
  rules override global ones.
- That automatic push can miss context for terse or oblique tasks. So before a
  choice that could reasonably depend on how this developer or repository usually
  works — a dependency, test framework, data store, language/runtime, formatter,
  convention, architecture decision, how the user wants to be addressed, or a
  decision the project already settled — and when that context was not already
  injected this turn, retrieve it yourself: run
  \`ctx get --cwd "$PWD" --task "<concise task>"\` (read-only, safe anytime). This
  includes oblique, outcome-phrased requests ("give this a safety net", "make it
  production-ready", "add persistence", "clean this up"): they often still hide such a
  choice, so translate the goal into the decision axis it implies (testing, database,
  deployment, architecture, …) and check that. The test is whether the right
  implementation could depend on an existing user/project decision, not whether the
  task is vague. Pass a
  semantic query naming the underlying decision, not a bare keyword echo (e.g.
  "preferred name / how to address the user", not "what do you call me"). Do not
  query for requests that clearly do not depend on developer/project context
  (general factual questions, explaining a concept or error), and do not re-fetch
  context you were already given. The \`context\` skill has the full boundary.
- When the user explicitly tells you to check ("ctx it", "check ctx", "check
  memory", "look that up in ctx"), retrieve before answering — the command is not
  the query; build the query from their immediately preceding unresolved request,
  then answer it. The \`context\` skill has the full boundary.
- Save developer context the user authors, without being asked. ${SAVE_POLICY_CORE}
  Write ONLY through the ctx AGENT surface with \`--origin user\` — it is the
  provenance-safe path and the ONLY one ctx's installed permissions auto-approve;
  the bare human \`ctx remember\`/\`propose\`/\`signal add\` are NOT auto-approved and
  will interrupt for permission, so never use them for an autonomous save. Use
  \`ctx agent remember --origin user\` for a durable preference (a terse standalone line
  like "Stick to pnpm in this repo." still counts — persist it, then continue) and
  \`ctx agent signal add --origin user\` for a one-off decision. A durable correction
  becomes the new authoritative rule — persist it (ctx reconciles exclusive choices by
  precedence; use \`context-learn\` to retract a contradicted rule); a temporary override
  never replaces a durable default. The \`context-learn\` skill has the full protocol.
- If the user asks to see goatedcontext/ctx usage stats (e.g. "show my ctx stats",
  "how often has ctx helped", "how many times has ctx injected preferences"), run
  \`ctx stats\` and show the result rather than estimating from memory. Only when
  asked — never run it automatically.
- Never store secrets, credentials, tokens, private keys, or environment variable
  values as developer preferences. Secrets belong only in \`ctx\` environments
  (\`context-env\` skill).
${CTX_INSTRUCTION_END}`;
