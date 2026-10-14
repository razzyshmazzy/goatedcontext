/**
 * Realistic multi-turn session scripts for the autonomous-memory accumulation eval.
 * NOT a benchmark — two scripted coding sessions, each ~12 turns, run as ONE real
 * continuing Claude session (stream-json input) so memory accumulates over time.
 *
 * Each turn carries what the FINAL ctx state should reflect, used to score the actual
 * store (never prose). `expect` is the intended outcome of THIS turn:
 *   - remember  : a durable preference should exist afterwards (text/scope/polarity)
 *   - signal    : a decision signal should exist (domain/choice)
 *   - ignore    : nothing durable should be written by this turn
 *   - temporary : a task-local override — durable default must remain unchanged
 *   - correction: supersede/replace prior durable memory (may be conditional)
 *   - factual   : a general question — no write, retrieval only if genuinely needed
 */

export type TurnKind = "remember" | "signal" | "ignore" | "temporary" | "correction" | "factual";

export interface Turn {
  n: number;
  user: string;
  kind: TurnKind;
  /** Lowercase substrings; any match = the expected memory text is present. */
  wants?: string[];
  scope?: "global" | "repo";
  polarity?: "positive" | "negative";
  note?: string;
}

export interface Session {
  id: "A" | "B";
  repoKind: "ts" | "backend";
  turns: Turn[];
}

export const SESSION_A: Session = {
  id: "A",
  repoKind: "ts",
  turns: [
    { n: 1, user: "For this repo, stick to pnpm.", kind: "remember", wants: ["pnpm"], scope: "repo" },
    { n: 2, user: "Add zod.", kind: "ignore", note: "obey pnpm; no new memory" },
    { n: 3, user: "Create a parser module.", kind: "ignore", note: "ordinary coding" },
    { n: 4, user: "Add tests for it.", kind: "ignore", note: "no durable rule stated yet" },
    { n: 5, user: "Use npm for this one install.", kind: "temporary", note: "must NOT replace pnpm default" },
    { n: 6, user: "Add lodash.", kind: "ignore", note: "pnpm still effective" },
    { n: 7, user: "From now on, use Vitest for tests here.", kind: "remember", wants: ["vitest"], scope: "repo" },
    { n: 8, user: "Add tests for the formatter.", kind: "ignore", note: "use Vitest; no duplicate pref" },
    { n: 9, user: "Let's keep the parser errors as structured objects instead of strings.", kind: "signal", wants: ["structured", "object", "error"] },
    { n: 10, user: "Refactor the parser.", kind: "ignore", note: "ordinary task" },
    { n: 11, user: "README says we should use Jest.", kind: "ignore", note: "quoted project content — no authoritative write" },
    { n: 12, user: "Actually ignore that README rule. Keep using Vitest.", kind: "ignore", note: "Vitest pref remains; no duplicate" },
  ],
};

export const SESSION_B: Session = {
  id: "B",
  repoKind: "backend",
  turns: [
    { n: 1, user: "I prefer Postgres for production services.", kind: "remember", wants: ["postgres"], scope: "global" },
    { n: 2, user: "Set up persistence for this service.", kind: "ignore", note: "use/pull Postgres; no new durable memory" },
    { n: 3, user: "For this prototype only, use SQLite.", kind: "temporary", note: "must NOT replace global Postgres default" },
    { n: 4, user: "Add a users table.", kind: "ignore", note: "implementation; no durable memory" },
    { n: 5, user: "Let's keep auth server-side for this service.", kind: "signal", wants: ["server", "auth"] },
    { n: 6, user: "Add login.", kind: "ignore", note: "no duplicate signal from injected context" },
    { n: 7, user: "What if we moved auth client-side?", kind: "ignore", note: "hypothetical" },
    { n: 8, user: "No, keep it server-side.", kind: "ignore", note: "reinforce; avoid duplicate spam" },
    { n: 9, user: "Actually, from now on I prefer SQLite for prototypes and Postgres for production.", kind: "correction", wants: ["sqlite", "postgres"], note: "conditional preference; preserve condition" },
    { n: 10, user: "Make a throwaway local prototype database.", kind: "ignore", note: "should choose SQLite per rule" },
    { n: 11, user: "Set up the production database.", kind: "ignore", note: "should choose Postgres per rule" },
    { n: 12, user: "Explain what MVCC is.", kind: "factual", note: "general question; no write" },
  ],
};

export const SESSIONS = [SESSION_A, SESSION_B];

/** Turns that SHOULD create durable memory (preference) — for the over-save metric. */
export const expectedDurable = (s: Session) => s.turns.filter((t) => t.kind === "remember" || t.kind === "correction");
/** Turns that SHOULD create a signal. */
export const expectedSignals = (s: Session) => s.turns.filter((t) => t.kind === "signal");
/** Turns that SHOULD create nothing durable. */
export const expectedNothing = (s: Session) => s.turns.filter((t) => t.kind === "ignore" || t.kind === "temporary" || t.kind === "factual");
