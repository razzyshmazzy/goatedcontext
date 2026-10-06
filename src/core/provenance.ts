/**
 * Memory-write PROVENANCE (0.3.7) — the source/trust boundary for durable memory.
 *
 * Threat: persistent-memory prompt injection. Untrusted content a coding agent reads
 * (repo files, README/AGENTS.md, source comments, tool/compiler/terminal output, web
 * pages, retrieved context, the agent's OWN prior text) can TELL the agent to save a
 * durable preference. Those sources may describe project requirements, but they are
 * NOT evidence of the developer's own durable intent, and must not be able to create
 * or strengthen an authoritative preference just by saying so.
 *
 * This module is the small, deterministic source classification the write path checks.
 * It is NOT a content classifier, moderation layer, or prompt-injection detector — it
 * only answers "is this write allowed to represent the developer's durable intent?"
 * given a provenance label the caller supplies. The label itself is set by the host
 * integration / memory protocol; see the honest limitation in the security docs: the
 * model still mediates classification, so this reduces accidental and source-confused
 * writes rather than proving human intent cryptographically.
 */

/** The source classes a memory write can carry. Deliberately tiny — not a taxonomy. */
export const MEMORY_SOURCES = ["user", "project", "external", "agent", "unknown"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * Human-readable meaning:
 *  - user     — the developer's own current message / decision (the ONLY trusted root
 *               for authoritative durable writes).
 *  - project  — repository content: files, README, AGENTS.md, source, comments.
 *  - external — tool/compiler/terminal output, web pages, dependency docs, retrieved
 *               context, generated/model output.
 *  - agent    — the agent's own inference or prior output (not developer intent).
 *  - unknown  — unclassified or legacy (pre-0.3.7) data.
 */
const DESCRIPTIONS: Record<MemorySource, string> = {
  user: "the developer's own message or decision",
  project: "repository content (files, README, AGENTS.md, source)",
  external: "tool output, a web page, dependency docs, or generated text",
  agent: "the agent's own inference or prior output",
  unknown: "an unclassified or legacy source",
};

export function memorySourceDescription(s: MemorySource): string {
  return DESCRIPTIONS[s];
}

/**
 * Normalize a raw/legacy label to a canonical class. An EMPTY/omitted label resolves to
 * `user` — a bare, human-initiated write (manual CLI, or an in-process caller that did
 * not specify a source) is treated as direct developer action. A NULL from storage
 * (a legacy row written before provenance existed) is passed as `null` and resolves to
 * `unknown`, so old data is never silently upgraded to trusted `user`.
 */
export function normalizeMemorySource(raw: string | null | undefined): MemorySource {
  if (raw === null) return "unknown"; // explicit storage NULL → legacy
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "user"; // omitted on a fresh write → direct action
  if (["user", "user_explicit", "explicit", "manual", "reinforcement", "user_reinforcement", "user_pattern"].includes(v))
    return "user";
  if (["project", "repo", "repository", "agents-md", "agents.md", "project_instruction", "readme"].includes(v))
    return "project";
  if (
    ["external", "tool", "tool_output", "web", "web_content", "dependency", "compiler", "terminal", "model", "model_output", "generated", "retrieved"].includes(
      v,
    )
  )
    return "external";
  if (["agent", "agent_inference", "self", "assistant"].includes(v)) return "agent";
  return "unknown";
}

/**
 * May this source directly CREATE or STRENGTHEN an authoritative durable preference
 * (`remember`) or a candidate preference about the developer (`propose`)? Only the
 * user's own intent qualifies. Everything else — project files, tool/web output, the
 * agent's own text, or an unclassified source — is refused by the write guard.
 */
export function isUserOriginated(s: MemorySource): boolean {
  return s === "user";
}

/**
 * May a decision SIGNAL with this source feed cross-repo preference LEARNING (surfacing
 * as evidence, and counting toward a proposal)? Developer decisions qualify. Legacy
 * (`unknown`) signals keep surfacing as historical evidence for backward compatibility
 * — they predate provenance and came from the user's own agent sessions under the old
 * protocol. Project/external/agent-inference signals are recorded only as inert rows
 * and are EXCLUDED from learning, so repeated untrusted content cannot fabricate a
 * cross-repo pattern.
 */
export function isLearningEligible(s: MemorySource): boolean {
  return s === "user" || s === "unknown";
}
