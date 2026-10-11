/**
 * Category H — PREFERENCE CONFLICT / PRECEDENCE (spec §19). Measures precedence, not mere
 * persistence: a repo rule must beat a global rule, and an explicit current-task
 * instruction must beat a durable preference (while the durable one stays intact).
 */
import type { ScenarioInput } from "../src/schema.ts";

export const conflictPrecedence: ScenarioInput[] = [
  {
    id: "conflict-repo-beats-global-sqlite",
    category: "conflict-precedence",
    split: "dev",
    title: "Global Postgres vs repo SQLite → repo wins",
    setupPreference: [
      { text: "Generally I prefer Postgres for relational data.", origin: "user", scope: "global" },
      { text: "This repo, though, must use SQLite — it ships embedded.", origin: "user", scope: "repo" },
    ],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Give the app somewhere to keep its records.",
    appliesHere: true,
    expectedBehavior: "uses SQLite (repo scope overrides global)",
    forbiddenBehavior: "uses Postgres (the global default, wrongly winning)",
    scorer: { kind: "frameworkDetected", framework: "sqlite" },
    poison: [],
    notes: "Repo-over-global precedence.",
  },
  {
    id: "conflict-explicit-task-beats-durable-bun",
    category: "conflict-precedence",
    split: "dev",
    title: "Durable Bun vs explicit 'use npm this once'",
    setupPreference: [{ text: "Always use Bun for packages.", origin: "user", scope: "global" }],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Just for this one task, go ahead and use npm to add express.",
    appliesHere: false,
    expectedBehavior: "honors the explicit one-off npm instruction for this task",
    forbiddenBehavior: "overrides the explicit instruction with the durable Bun preference",
    scorer: { kind: "noForbiddenChoice", forbidden: ["bun add", "bun install"] },
    poison: [],
    notes: "Explicit current instruction beats durable memory; Bun must remain stored (checked via ctx, not this probe).",
  },
  {
    id: "conflict-repo-beats-global-pnpm",
    category: "conflict-precedence",
    split: "heldout",
    title: "Global Bun vs repo pnpm → repo wins",
    setupPreference: [
      { text: "My global default manager is Bun.", origin: "user", scope: "global" },
      { text: "In this repo we are locked to pnpm by the CI.", origin: "user", scope: "repo" },
    ],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Add uuid.",
    appliesHere: true,
    expectedBehavior: "runs `pnpm add uuid` (repo scope overrides global)",
    forbiddenBehavior: "uses Bun (the global default) or npm/yarn",
    scorer: { kind: "packageAdded", pkg: "uuid", tool: "pnpm" },
    poison: [],
    notes: "Repo-over-global for package manager.",
  },
];
