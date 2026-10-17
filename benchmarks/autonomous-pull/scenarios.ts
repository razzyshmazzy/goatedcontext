/**
 * Autonomous-pull benchmark scenarios (v1.1 pass).
 *
 * This set answers exactly ONE question: SHOULD the agent call ctx for this task?
 * It is deliberately SEPARATE from the full developer-memory benchmark and must NOT
 * reuse held-out v1.1 scenarios as tuning data (spec §8). Each scenario is either
 * memory-RELEVANT (a latent decision that should depend on stored developer/project
 * context) or memory-IRRELEVANT (a general/factual task where memory must not matter).
 *
 * Seeds use `relevant` applicability (surfaced only on a related task) so an
 * IRRELEVANT probe retrieves nothing — making "a ctx call here was unnecessary"
 * deterministically checkable. The repo-convention seed is repo-scoped.
 */

export type ScenarioClass =
  | "dependency"
  | "testing"
  | "database"
  | "language-runtime"
  | "framework-tool"
  | "repo-convention"
  | "architecture"
  | "conditional-convention"
  | "state-management"
  | "general-knowledge";

export interface Seed {
  rule: string;
  scope: "global" | "repo";
  /** `relevant` = surfaced only on a related task; `always` = every turn. */
  applicability: "relevant" | "always";
}

export interface Scenario {
  id: string;
  klass: ScenarioClass;
  /** True when a stored preference/convention SHOULD inform this task. */
  relevant: boolean;
  /** The user's terse/oblique prompt — exactly what an agent would receive. */
  probe: string;
  /** Preference to seed for this scenario (relevant scenarios only). */
  seed?: Seed;
  /** Lowercase substrings; retrieval "hit" = a returned rule contains any of them. */
  expectRuleIncludes?: string[];
}

/**
 * RELEVANT scenarios (one per decision class, spec §9). Each seeds a meaningful
 * preference whose presence should steer the task.
 */
export const RELEVANT: Scenario[] = [
  {
    id: "R-dependency",
    klass: "dependency",
    relevant: true,
    probe: "Add uuid.",
    seed: { rule: "Use nanoid instead of uuid for generating IDs.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["nanoid"],
  },
  {
    id: "R-testing",
    klass: "testing",
    relevant: true,
    probe: "Write tests for this parser.",
    seed: { rule: "Use Vitest for unit tests.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["vitest"],
  },
  {
    id: "R-database",
    klass: "database",
    relevant: true,
    probe: "Set up persistence for production.",
    seed: { rule: "Use PostgreSQL for relational persistence.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["postgres", "postgresql"],
  },
  {
    id: "R-language-runtime",
    klass: "language-runtime",
    relevant: true,
    probe: "Parse this log file.",
    seed: { rule: "Use Python to parse and process log files.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["python"],
  },
  {
    id: "R-framework-tool",
    klass: "framework-tool",
    relevant: true,
    probe: "Set up code formatting and linting.",
    seed: { rule: "Use Biome to format and lint code.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["biome"],
  },
  {
    id: "R-repo-convention",
    klass: "repo-convention",
    relevant: true,
    probe: "Create another API endpoint.",
    seed: {
      rule: "API endpoints return a { data, error } envelope and never throw past the handler.",
      scope: "repo",
      applicability: "relevant",
    },
    expectRuleIncludes: ["envelope", "{ data, error }"],
  },
  {
    id: "R-architecture",
    klass: "architecture",
    relevant: true,
    probe: "Add caching.",
    seed: { rule: "Use Redis for caching.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["redis"],
  },
  {
    id: "R-conditional-convention",
    klass: "conditional-convention",
    relevant: true,
    probe: "Add tests to this Vite project.",
    seed: { rule: "In Vite projects, prefer Vitest for testing.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["vitest", "vite"],
  },
  {
    id: "R-state-management",
    klass: "state-management",
    relevant: true,
    probe: "Add a store for the app's shared state.",
    seed: { rule: "Use Zustand for client state management.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["zustand"],
  },
];

/**
 * IRRELEVANT scenarios (spec §10): general/factual/conceptual tasks. A ctx call here
 * is an UNNECESSARY retrieval. They carry no seed of their own — the relevant seeds
 * remain in the store, and must NOT surface for these.
 */
export const IRRELEVANT: Scenario[] = [
  { id: "N-tcp-slow-start", klass: "general-knowledge", relevant: false, probe: "Explain TCP slow start." },
  { id: "N-http-404", klass: "general-knowledge", relevant: false, probe: "What does HTTP 404 mean?" },
  {
    id: "N-error-summary",
    klass: "general-knowledge",
    relevant: false,
    probe: "Summarize what 'ECONNREFUSED 127.0.0.1:6379' means.",
  },
  { id: "N-big-o", klass: "general-knowledge", relevant: false, probe: "What does Big-O notation mean?" },
  { id: "N-git-rebase", klass: "general-knowledge", relevant: false, probe: "Explain what a git rebase does." },
  { id: "N-mutex", klass: "general-knowledge", relevant: false, probe: "What is a mutex?" },
  { id: "N-regex-greedy", klass: "general-knowledge", relevant: false, probe: "Why is the regex /a.*b/ greedy?" },
  {
    id: "N-sql-explain",
    klass: "general-knowledge",
    relevant: false,
    probe: "Walk me through what SELECT * FROM users WHERE id = 1 returns.",
  },
  { id: "N-tcp-vs-udp", klass: "general-knowledge", relevant: false, probe: "What's the difference between TCP and UDP?" },
];

/**
 * OBLIQUE call-recognition pilot set (spec §8). These are OUTCOME-phrased prompts whose
 * stored decision is never named in the words — the exact failure mode this pass targets.
 * Four should-call (each seeded with a decision that materially changes the implementation)
 * and two should-NOT-call conceptual questions. Six total = the hard-capped live budget.
 */
export const PILOT_OBLIQUE_RELEVANT: Scenario[] = [
  {
    id: "PO-safety-net",
    klass: "testing",
    relevant: true,
    probe: "Give this parser a safety net.",
    seed: { rule: "Use Vitest for unit tests.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["vitest"],
  },
  {
    id: "PO-persistence",
    klass: "database",
    relevant: true,
    probe: "Add persistence.",
    seed: { rule: "Use PostgreSQL for relational persistence.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["postgres", "postgresql"],
  },
  {
    id: "PO-production-ready",
    klass: "architecture",
    relevant: true,
    probe: "Make this production ready.",
    seed: {
      rule: "Deploy services to Fly.io with health checks and graceful shutdown.",
      scope: "global",
      applicability: "relevant",
    },
    expectRuleIncludes: ["fly.io", "fly"],
  },
  {
    id: "PO-clean-up",
    klass: "architecture",
    relevant: true,
    probe: "Clean this up.",
    seed: {
      rule: "Follow hexagonal architecture: keep domain logic free of I/O and frameworks.",
      scope: "repo",
      applicability: "relevant",
    },
    expectRuleIncludes: ["hexagonal"],
  },
];

export const PILOT_OBLIQUE_NEG: Scenario[] = [
  {
    id: "PO-neg-eviction",
    klass: "general-knowledge",
    relevant: false,
    probe: "Explain how Redis cache eviction works.",
  },
  {
    id: "PO-neg-oauth",
    klass: "general-knowledge",
    relevant: false,
    probe: "What is OAuth and how does the authorization-code flow work?",
  },
];

export const PILOT_OBLIQUE: Scenario[] = [...PILOT_OBLIQUE_RELEVANT, ...PILOT_OBLIQUE_NEG];

/**
 * RETRIEVAL-ENGINE live validation set (engine pass, spec §12). Four cases that stress
 * the engine improvements END-TO-END through a real model: morphology + proper-noun +
 * domain recall on three should-call tasks (each previously an engine miss or ceiling),
 * and one explanatory negative that must NOT call under the standing pull policy. The
 * negative carries a seed too, so the store holds a topically-adjacent Redis preference
 * the engine's intent gate would refuse even if the model asked.
 */
export const PILOT_ENGINE: Scenario[] = [
  {
    id: "E-production-ready",
    klass: "architecture",
    relevant: true,
    probe: "Make this production ready.",
    seed: {
      rule: "Deploy services to Fly.io with health checks and graceful shutdown.",
      scope: "global",
      applicability: "relevant",
    },
    expectRuleIncludes: ["fly.io", "fly"],
  },
  {
    id: "E-job-queue",
    klass: "architecture",
    relevant: true,
    probe: "Add a job queue.",
    seed: { rule: "Use BullMQ for background jobs.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["bullmq"],
  },
  {
    id: "E-persistence",
    klass: "database",
    relevant: true,
    probe: "Add production persistence.",
    seed: { rule: "Prefer Postgres in production.", scope: "global", applicability: "relevant" },
    expectRuleIncludes: ["postgres"],
  },
  {
    id: "E-neg-redis-eviction",
    klass: "general-knowledge",
    relevant: false,
    probe: "Explain how Redis eviction works.",
    // seeded so the store holds an adjacent decision; the pull policy should keep the
    // model from calling at all, and the engine's intent gate is the backstop.
    seed: { rule: "Prefer Redis for caching.", scope: "global", applicability: "relevant" },
  },
];

export const ALL_SCENARIOS: Scenario[] = [...RELEVANT, ...IRRELEVANT];

/** Every distinct seed to install once into the isolated store before any trial. */
export function seedsFor(scenarios: Scenario[] = RELEVANT): Array<{ scenarioId: string; seed: Seed }> {
  return scenarios.filter((s) => s.seed).map((s) => ({ scenarioId: s.id, seed: s.seed! }));
}
