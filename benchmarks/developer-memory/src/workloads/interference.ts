/**
 * Standardized interference workloads (spec §14).
 *
 * These are realistic, preference-NEUTRAL coding turns whose only job is to bury the
 * earlier preference under genuine agent work — not random lorem ipsum. The SAME pack is
 * used for both conditions at a given level, so neither side gets an easier workload
 * (spec §2). Packs are ordered; a "depth sweep" (spec §15) can take prefixes of a pack.
 *
 * Levels are defined by step count and approximate prompt bytes (labeled honestly: these
 * are workload steps / bytes, NOT measured model token depth — spec §4).
 */
import type { InterferenceLevel } from "../schema.ts";

const BANK: string[] = [
  "List the files in src/ and summarize what each one does.",
  "Explain the difference between a mutex and a semaphore.",
  "Write a function that debounces an async callback.",
  "Add input validation to the function you just wrote.",
  "There's a failing assertion about off-by-one indexing — walk me through likely causes.",
  "Refactor the debounce helper to cancel in-flight calls on dispose.",
  "What are the trade-offs between a monorepo and polyrepo for a 5-service backend?",
  "Generate a small CSV fixture with 10 rows of synthetic order data.",
  "Inspect the git diff and describe what changed at a high level.",
  "Explain what TCP slow start is and when it matters.",
  "Write a short docstring for the index module.",
  "Analyze this error: `TypeError: cannot read properties of undefined (reading 'id')`.",
  "Sketch a retry-with-backoff wrapper for a flaky network call.",
  "What is the CAP theorem and which guarantees does a typical cache relax?",
  "Rename the `ok` export to `ready` and update its only usage.",
  "Describe how you'd structure logging for a request-scoped trace id.",
];

const LEVEL_STEPS: Record<InterferenceLevel, number> = {
  none: 0,
  light: 2,
  medium: 5,
  heavy: 12,
};

/** The interference turns for a level (a prefix of the bank, repeating if needed). */
export function interferenceTurns(level: InterferenceLevel): string[] {
  const n = LEVEL_STEPS[level];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(BANK[i % BANK.length]!);
  return out;
}

/** Approximate prompt bytes of a workload level (reported honestly, not token depth). */
export function interferenceBytes(level: InterferenceLevel): number {
  return interferenceTurns(level).reduce((a, s) => a + Buffer.byteLength(s, "utf8"), 0);
}
