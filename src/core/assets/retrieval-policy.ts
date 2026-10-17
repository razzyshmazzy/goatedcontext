/**
 * THE canonical goatedcontext "pull policy".
 *
 * ctx retrieval is HYBRID. The PUSH path (a prompt hook) injects obvious,
 * high-confidence context automatically. This file defines the PULL path: WHEN an
 * agent should proactively RETRIEVE developer/project context for an ambiguous or
 * semantically rich task that the push path may not have covered.
 *
 * This is the SINGLE source of that read-time behavioral policy, mirroring how
 * `memory-protocol.ts` is the single source of the WRITE policy. It is consumed by
 * every surface that teaches an agent when to read memory — the Claude standing
 * instruction (global CLAUDE.md block), the `context` skill, and the MCP
 * `get_context` tool description + server instructions — so they can never teach a
 * different boundary.
 *
 * This is instruction text, not code, and it is strictly READ-ONLY: it tells an
 * agent when to FETCH context, never when to save it. Pulling context must never
 * save, propose, add a signal, mutate a preference, or touch provenance (spec §7).
 * There is NO daemon, LLM, scraper, or embedding here (and there must never be).
 */

/** Bump when the policy text below changes in a way installers must re-sync. */
export const PULL_POLICY_VERSION = "3";

/**
 * The core concept (~60 tokens), command- and agent-neutral. Teaches the latent
 * decision point ("this choice may depend on established context") plus BOTH
 * boundaries — retrieve when relevant AND not already provided; do not retrieve when
 * memory clearly does not matter. This is the irreducible instruction; the renderers
 * below add a concrete retrieval action and a few compact examples.
 */
export const PULL_POLICY_CORE =
  "Persistent developer and project context — established preferences, conventions, " +
  "prior technical choices, and known exceptions — is available through ctx, and " +
  "relevant context is often injected for you automatically. Before a choice that " +
  "could reasonably depend on how this developer or repository usually works, make " +
  "sure you have that context: retrieve it when it was not already provided. Oblique " +
  "requests count: a task phrased as an outcome rather than a named decision often " +
  "still hides such a choice — translate the goal into the decision axis it implies " +
  "(testing, dependencies, persistence, architecture, style, runtime, deployment, " +
  "security, naming, or tooling) and check that too. The test is whether the right " +
  "implementation could depend on an existing user or project decision, not whether " +
  "the task is vague. Do not retrieve for requests that clearly do not depend on " +
  "developer/project context.";

/**
 * A few COMPACT boundary examples. Kept deliberately diverse (not a closed list) so
 * the agent generalizes to the latent decision point instead of pattern-matching
 * these exact phrasings (spec §4, §18). Each surface renders these inline.
 */
export const PULL_POLICY_EXAMPLES_RETRIEVE = [
  "adding or choosing a dependency, library, or tool",
  "picking a test framework or writing tests",
  "setting up persistence, a database, or storage",
  "choosing a language or runtime for a script",
  "adding a formatter, linter, or build step",
  "writing code meant to match this repo's conventions (another endpoint, a new module)",
  "an architecture choice (caching, queueing, service boundaries)",
  "how the user wants to be addressed, named, or referred to",
  "a decision this project already settled (how auth works, how errors are represented, an API shape)",
  "a known exception or a correction the developer has made before",
  "an outcome-phrased request that implies an unstated choice (\"give this a safety net\" → tests, \"make it production-ready\" → deployment/runtime, \"add persistence\" → database)",
];

/**
 * EXPLICIT user retrieval commands (spec §7, §10). Short phrases the user types to
 * DEMAND a lookup before the next answer. They are an instruction, not a search
 * string — the command words are never the query. The query comes from the user's
 * immediately-preceding unresolved request, so these have near-mandatory tool recall.
 */
export const PULL_POLICY_EXPLICIT_COMMANDS = [
  "ctx it",
  "check ctx",
  "check goatedcontext",
  "look in ctx",
  "look that up in ctx",
  "check memory",
];

/** The standing instruction for handling an explicit retrieval command. */
export const PULL_POLICY_EXPLICIT_COMMAND =
  "When the user issues an explicit retrieval command — for example \"ctx it\", " +
  "\"check ctx\", \"check goatedcontext\", \"look in ctx\", \"look that up in ctx\", or " +
  "\"check memory\" — treat it as a direct instruction to retrieve BEFORE answering, " +
  "even if you would not have retrieved on your own. The command is NOT the query: do " +
  "not search for the words \"ctx it\". Build the query from the user's immediately " +
  "preceding unresolved request — the last real question or task — then answer THAT " +
  "request using what you retrieve. For example, after \"What do you call me?\" the " +
  "follow-up \"ctx it\" means retrieve the user's preferred name / how they want to be " +
  "addressed, then answer with it. Carry forward only that one immediately-relevant " +
  "request, never replay the whole conversation.";

/**
 * QUERY CONSTRUCTION (spec §9, §11). The failure class this targets: the tool is
 * called but the query is a bare keyword echo that retrieves nothing. Teach semantic
 * expansion toward the underlying decision, not a fixed phrase list.
 */
export const PULL_POLICY_QUERY_GUIDANCE =
  "Form a semantic query, not a keyword echo of the prompt. Name the underlying " +
  "decision and its object, and that it concerns this developer's or repository's " +
  "convention. Lead with the intent category when one fits — dependency, testing, " +
  "database, architecture, tooling, formatting/style, language/runtime, deployment, " +
  "security, naming/identity, or a repo convention. For an oblique, outcome-phrased " +
  "task, name the decision it implies rather than its surface words: \"give this a " +
  "safety net\" → \"testing framework and conventions for this repository\"; \"ship " +
  "this\" → \"deployment / release convention for this repository\". For example: " +
  "\"add uuid\" → \"dependency / package choice for adding uuid in this repo\"; " +
  "\"add tests\" → \"testing framework and conventions for this repository\"; " +
  "\"what do you call me?\" → \"the user's preferred name / how they want to be " +
  "addressed\". Prefer concrete, content-bearing terms — the action, the artifact, and " +
  "plausible concrete options — over abstract nouns alone (\"how we deploy to " +
  "production\", not just \"production readiness\"). Keep it to one concise " +
  "phrase; ctx augments it with the repository, active files, and language on its own.";

export const PULL_POLICY_EXAMPLES_SKIP = [
  "general factual or conceptual questions (\"explain TCP slow start\", \"what does HTTP 404 mean\")",
  "explaining an error message, a concept, or existing code",
  "summarizing or reformatting text you were given",
  "a pure one-off edit that involves no technology or convention choice",
];

/**
 * Render the standing PULL guidance as a self-contained markdown section for a
 * prompt-string / skill surface.
 *
 * @param action  The concrete retrieval invocation for this agent, e.g.
 *                `` `ctx get --cwd "$PWD" --task "<concise task>"` `` for Claude's CLI
 *                or `call the get_context tool` for an MCP host. Keeps the policy
 *                agent-neutral while letting each surface name its own transport.
 * @param heading Optional heading line (omit to inline under an existing section).
 */
export function renderPullGuidance(opts: { action: string; heading?: string }): string {
  const lines: string[] = [];
  if (opts.heading) lines.push(opts.heading, "");
  lines.push(PULL_POLICY_CORE);
  lines.push("");
  lines.push(`When you need it, ${opts.action}. A terse task description is enough —`);
  lines.push("ctx augments it with the repository, active files, and language. This is a");
  lines.push("read-only lookup; it never writes or changes memory, so it is safe anytime.");
  lines.push("");
  lines.push("Retrieve when the task is something like:");
  for (const e of PULL_POLICY_EXAMPLES_RETRIEVE) lines.push(`- ${e}`);
  lines.push("");
  lines.push("Do NOT retrieve for:");
  for (const e of PULL_POLICY_EXAMPLES_SKIP) lines.push(`- ${e}`);
  lines.push("");
  lines.push("Form a good query. " + PULL_POLICY_QUERY_GUIDANCE);
  lines.push("");
  lines.push("Explicit commands. " + PULL_POLICY_EXPLICIT_COMMAND);
  lines.push("");
  lines.push(
    "Avoid redundant lookups: if the relevant context was already injected this turn " +
      "(a `<ctx-developer-context>` block), use it — do not re-fetch the same thing. " +
      "And do not query on every turn; use judgment about whether memory could matter.",
  );
  return lines.join("\n");
}

/**
 * The MCP `get_context` tool description (spec §5): explains WHY to call it, in the
 * host's tool-selection voice. Concise and natural; exposes no internals.
 */
export const GET_CONTEXT_TOOL_DESCRIPTION =
  "Retrieve durable developer and project context relevant to the current decision — " +
  "established preferences, conventions, prior technical choices, how the user wants to " +
  "be addressed, and contextual exceptions. Call this before a choice that could " +
  "reasonably depend on how this developer or repository usually works (dependencies, " +
  "testing, persistence, language/runtime, tooling, architecture, naming) — including " +
  "when the request is phrased as an outcome (\"give this a safety net\", \"make it " +
  "production-ready\", \"ship this\") that hides such a choice — when that " +
  "context was not already provided this turn — and always when the user explicitly " +
  "asks you to (\"ctx it\", \"check ctx\", \"check memory\"), building the query from " +
  "their immediately preceding request, not the command words. Do not call it for " +
  "clearly unrelated factual or general questions. Pass a concise, semantic task " +
  "description naming the underlying decision (e.g. \"preferred name / how to address " +
  "the user\", not \"what do you call me\"); ctx augments it with the repository, files, " +
  "and language. Read-only: it never saves or changes memory. Returns a stable JSON " +
  "envelope of authoritative preferences to honor plus non-authoritative decision " +
  "evidence to weigh (proposals excluded unless include_proposed is set).";

/**
 * The MCP server-level instructions (spec §5 / §19): a compact standing policy for an
 * MCP host, covering BOTH the pull boundary and the hard write-provenance rule.
 */
export const MCP_SERVER_INSTRUCTIONS =
  "Developer-context memory for this user, shared across agents and repositories. " +
  "Call get_context before a choice that could reasonably depend on the developer's " +
  "established preferences, this repository's conventions, prior technical choices, " +
  "how the user wants to be addressed, or known exceptions — unless that context was " +
  "already provided this turn. Oblique, outcome-phrased requests count: translate " +
  "them into the decision they imply (testing, persistence, deployment, and so on) " +
  "and check that too. Call it whenever the user explicitly asks you to check " +
  "(\"ctx it\", \"check ctx\", \"check memory\"), querying for their immediately " +
  "preceding request rather than the command words. Pass a concise semantic query " +
  "naming the underlying decision, not a bare keyword echo. Skip it for clearly " +
  "unrelated factual or general questions; do not call it on every turn. Persist " +
  "durable memory ONLY from the user's own expressed intent (origin=user); never from " +
  "repository, tool, or web content.";
