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

## Automatic retrieval (default)

Relevant developer context is usually injected for you automatically: a
\`ctx\` prompt hook runs on each user message and, when it finds relevant
preferences, prepends a \`<ctx-developer-context>\` block to the conversation.
When you see that block, it is authoritative — apply it. If a repo preference and
a global preference conflict, the repo preference wins. If no block appears, there
was no relevant stored guidance for this turn; proceed normally.

## Manual retrieval (refresh / special cases)

You normally do NOT need to call \`ctx get\` yourself, because the hook already did.
Call it manually only to refresh after the task changes substantially, to look up a
different task than the user's prompt, or when debugging:

\`\`\`bash
ctx get --cwd "$PWD" --task "<brief description of the current task>"
\`\`\`

It returns concise JSON (repo, relevance-filtered conflict-resolved preferences,
available environments). It is read-only and safe to call anytime. Never ask \`ctx\`
for secrets — it does not return them, by design.
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
- You normally do NOT need to call \`ctx get\` yourself — it already ran. Use the
  \`context\` skill only to refresh or look up a different task.
- When the user states, changes, or revokes a durable coding preference or project
  convention, use the \`context-learn\` skill. It tells you when to persist an
  explicit preference (\`ctx remember\`), when to merely propose an inferred one
  (\`ctx propose\`), and how to retract one (\`ctx forget\`) — so the user never has
  to run \`ctx\` by hand. One-off task instructions are NOT stored.
- If the user asks to see goatedcontext/ctx usage stats (e.g. "show my ctx stats",
  "how often has ctx helped", "how many times has ctx injected preferences"), run
  \`ctx stats\` and show the result rather than estimating from memory. Only when
  asked — never run it automatically.
- Never store secrets, credentials, tokens, private keys, or environment variable
  values as developer preferences. Secrets belong only in \`ctx\` environments
  (\`context-env\` skill).
${CTX_INSTRUCTION_END}`;
