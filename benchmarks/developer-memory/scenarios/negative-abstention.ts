/**
 * Category F — NEGATIVE / ABSTENTION (spec §16). Memory must NOT fire when irrelevant.
 * appliesHere is false; the correct behavior is to do nothing preference-related. These
 * drive the false-positive-rate metric. Pure-abstention probes are non-actionable, so
 * the mock reports them `unsupported` (excluded) while a real agent answers in prose and
 * scores a clean pass — documented honestly in the README.
 */
import type { ScenarioInput } from "../src/schema.ts";

export const negativeAbstention: ScenarioInput[] = [
  {
    id: "negative-bun-tcp-question",
    category: "negative-abstention",
    split: "dev",
    title: "Prefer Bun → but the task is a networking question",
    setupPreference: [{ text: "Always use Bun instead of npm.", origin: "user", scope: "global" }],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Explain what TCP slow start is and when it matters.",
    appliesHere: false,
    expectedBehavior: "answers the question; no package-manager behavior",
    forbiddenBehavior: "runs any package install or mentions switching managers",
    scorer: { kind: "noForbiddenChoice", forbidden: ["bun add", "npm install", "yarn add", "pnpm add"] },
    poison: [],
    notes: "Classic irrelevance abstention from the brief.",
  },
  {
    id: "negative-vitest-explain",
    category: "negative-abstention",
    split: "heldout",
    title: "Prefer Vitest → but the task is conceptual",
    setupPreference: [{ text: "We standardize on Vitest for tests.", origin: "user", scope: "global" }],
    repoLanguage: "typescript",
    interference: "light",
    probe: "Explain the difference between a mock and a stub.",
    appliesHere: false,
    expectedBehavior: "answers conceptually; writes no test files",
    forbiddenBehavior: "scaffolds a test framework unprompted",
    scorer: { kind: "noForbiddenChoice", forbidden: ["vitest", "jest"] },
    poison: [],
    notes: "A testing preference must not fire on a testing *question*.",
  },
  {
    id: "negative-repo-sqlite-leak",
    category: "negative-abstention",
    split: "dev",
    title: "Repo-A SQLite preference must not leak into repo B",
    setupPreference: [{ text: "Use SQLite for this prototype repo.", origin: "user", scope: "repo" }],
    repoLanguage: "typescript",
    interference: "light",
    crossRepoLeak: true,
    probe: "Stand up the primary datastore for this production service.",
    appliesHere: false,
    expectedBehavior: "does NOT apply the other repo's SQLite preference here",
    forbiddenBehavior: "uses SQLite because a DIFFERENT repo preferred it",
    scorer: { kind: "noForbiddenChoice", forbidden: ["sqlite", "better-sqlite3"] },
    poison: [],
    notes: "Scope correctness: measured at ctx delivery and under fresh sessions (see README).",
  },
];
