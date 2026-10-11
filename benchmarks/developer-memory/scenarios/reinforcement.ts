/**
 * Category I — REINFORCEMENT / DUPLICATES (spec §18, secondary). The user restates the
 * same preference. Later application must remain correct; ctx should accumulate evidence
 * rather than spawn duplicate rows (the dedup property is a ctx-internal invariant checked
 * in the harness's ctx-participation test, not by the behavioral probe here).
 */
import type { ScenarioInput } from "../src/schema.ts";

export const reinforcement: ScenarioInput[] = [
  {
    id: "reinforce-bun-twice",
    category: "reinforcement",
    split: "dev",
    title: "Bun stated twice → still Bun",
    setupPreference: [
      { text: "Use Bun for packages.", origin: "user", scope: "global" },
      { text: "Yeah, definitely stick with Bun going forward.", origin: "user", scope: "global" },
    ],
    repoLanguage: "typescript",
    interference: "medium",
    probe: "Add zod.",
    appliesHere: true,
    expectedBehavior: "runs `bun add zod`",
    forbiddenBehavior: "npm / yarn / pnpm install",
    scorer: { kind: "packageAdded", pkg: "zod", tool: "bun" },
    poison: [],
    notes: "Restatement should strengthen, not duplicate; behavior stays Bun.",
  },
  {
    id: "reinforce-vitest-twice",
    category: "reinforcement",
    split: "heldout",
    title: "Vitest reaffirmed → still Vitest",
    setupPreference: [
      { text: "We use Vitest for tests.", origin: "user", scope: "global" },
      { text: "Right, Vitest is our testing standard — keep it.", origin: "user", scope: "global" },
    ],
    repoLanguage: "typescript",
    interference: "heavy",
    probe: "Add coverage for the parser module.",
    appliesHere: true,
    expectedBehavior: "uses Vitest",
    forbiddenBehavior: "uses Jest",
    scorer: { kind: "frameworkDetected", framework: "vitest" },
    poison: [],
    notes: "Reaffirmation under heavy interference.",
  },
];
