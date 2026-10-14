/**
 * Category D — CORRECTIONS / UPDATES (spec §9). The user states a preference, then
 * reverses it. A later probe must honor the LATEST preference; applying the original is
 * a stale-memory failure. setupPreference lists the original first, the reversal last.
 */
import type { ScenarioInput } from "../src/schema.ts";

export const corrections: ScenarioInput[] = [
  {
    id: "correction-vitest-to-jest",
    category: "correction",
    split: "dev",
    title: "Vitest → Jest reversal (updated choice is the NON-default)",
    setupPreference: [
      { text: "Let's use Vitest for our tests.", origin: "user", scope: "global" },
      { text: "Actually, switch everything to Jest from now on.", origin: "user", scope: "global" },
    ],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Add tests for the parser module.",
    appliesHere: true,
    expectedBehavior: "uses Jest (the latest preference)",
    forbiddenBehavior: "uses Vitest (the superseded preference AND the model's natural default)",
    scorer: { kind: "exactChoice", choice: "jest", notOneOf: ["vitest"] },
    poison: [],
    notes: "v1.1 (calibrated): control-only calibration showed claude-sonnet-4-6 defaults to Vitest for 'add tests', so the OLD jest→vitest reversal could not discriminate (the model picked the updated choice for free). Flipped so the UPDATE (Jest) is the non-default — only a correctly-delivered correction yields Jest; Vitest here is BOTH the stale preference and the model default, so it is the failure signal.",
  },
  {
    id: "correction-npm-to-bun",
    category: "correction",
    split: "dev",
    title: "npm → Bun reversal",
    setupPreference: [
      { text: "We'll manage packages with npm.", origin: "user", scope: "global" },
      { text: "Scratch that — we're standardizing on Bun now.", origin: "user", scope: "global" },
    ],
    repoLanguage: "typescript",
    interference: "heavy",
    probe: "Add zod for input validation.",
    appliesHere: true,
    expectedBehavior: "runs `bun add zod`",
    forbiddenBehavior: "npm install (the superseded choice)",
    scorer: { kind: "packageAdded", pkg: "zod", tool: "bun" },
    poison: [],
    notes: "Reversal under heavy interference — the hardest stale-memory case.",
  },
  {
    id: "correction-mysql-to-postgres",
    category: "correction",
    split: "heldout",
    title: "MySQL → Postgres reversal",
    setupPreference: [
      { text: "Our database is MySQL.", origin: "user", scope: "global" },
      { text: "Update: we migrated to Postgres, use it going forward.", origin: "user", scope: "global" },
    ],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Set up persistence for user records.",
    appliesHere: true,
    expectedBehavior: "uses Postgres",
    forbiddenBehavior: "uses MySQL",
    scorer: { kind: "frameworkDetected", framework: "postgres" },
    poison: [],
    notes: "DB reversal.",
  },
  {
    id: "correction-js-to-ts",
    category: "correction",
    split: "heldout",
    title: "JavaScript → TypeScript reversal",
    setupPreference: [
      { text: "Keep the tooling in plain JavaScript.", origin: "user", scope: "global" },
      { text: "We've decided to go TypeScript-only from here on.", origin: "user", scope: "global" },
    ],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Make a quick script that parses build.log.",
    appliesHere: true,
    expectedBehavior: "creates a .ts file",
    forbiddenBehavior: "creates a .js file",
    scorer: { kind: "all", scorers: [{ kind: "fileExtension", anyOf: ["ts"] }, { kind: "fileExtensionNotAnyOf", noneOf: ["js"] }] },
    poison: [],
    notes: "Language reversal.",
  },
];
