import { test, expect } from "bun:test";
import { MEMORY_PROTOCOL_BODY } from "../src/core/assets/memory-protocol.ts";

/**
 * Preference-reconciliation policy (0.3.3) — deterministic guards over the ONE canonical
 * body. Preferences are defeasible DEFAULTS: explicit instructions, constraints, facts,
 * impossibility, and more-specific rules may require an exception WITHOUT deleting the
 * default. These assert the installed guidance encodes that (not a live LLM, no weights).
 */

const body = MEMORY_PROTOCOL_BODY;
function section(n: number): string {
  const start = body.indexOf(`## ${n}.`);
  const end = body.indexOf(`## ${n + 1}.`);
  return body.slice(start, end === -1 ? undefined : end);
}
const reconcile = body.slice(body.indexOf("## Preferences are DEFAULTS"), body.indexOf("## 1."));

// §1/§4 core principle: defaults, not commands.
test("preferences are taught as defeasible defaults, not absolute commands", () => {
  expect(reconcile).toContain("## Preferences are DEFAULTS, not commands");
  expect(reconcile).toContain("a strong default, not an absolute order");
  expect(reconcile).toContain("Satisfy as many durable");
  expect(reconcile).toContain("without being deleted");
  // All six override categories are present.
  for (const o of [
    "explicit current user instructions",
    "hard project requirement",
    "technical\nimpossibility",
    "security/safety constraint",
    "more-specific preference that applies",
    "plain fact about the current environment",
  ]) {
    expect(reconcile).toContain(o);
  }
});

// §3 of the spec: four distinct concepts, and facts/constraints are not persisted.
test("the four concepts (preference/constraint/fact/decision) are distinguished", () => {
  expect(reconcile).toContain("PREFERENCE — a durable default");
  expect(reconcile).toContain("CONSTRAINT — a requirement for THIS task/project");
  expect(reconcile).toContain("FACT — a technical/environment reality");
  expect(reconcile).toContain("DECISION — what you actually do after reconciling");
  expect(reconcile).toContain("Persist only PREFERENCES. Do NOT persist facts");
  expect(reconcile).toContain("do NOT turn a temporary constraint");
});

// §4/§21/§22/§23: current task overrides defaults WITHOUT erasing them.
test("environment/stack/task exceptions keep the default intact", () => {
  expect(reconcile).toContain("only supports npm -> use npm here; keep Bun");
  expect(reconcile).toContain("existing Vue app -> work in Vue; do not rewrite it");
  expect(reconcile).toContain("app is static with no backend -> do not invent a backend");
});

// §15/§26: partial stack — one conflicting component does not void the whole preference.
test("partial-stack reasoning is taught (keep the parts that still fit)", () => {
  expect(reconcile).toContain("keep Firebase where it still fits (e.g. Auth)");
  expect(reconcile).toContain("Do not replace the whole");
  expect(reconcile).toContain("stack because one component conflicts");
});

// §5: specificity uses EXISTING precedence, no new ranking / no numeric weights.
test("specificity reuses existing precedence; no new ranking or weights", () => {
  expect(reconcile).toContain("EXISTING scope/conditional");
  expect(reconcile).toContain('a repo "use Supabase here" beats a global "prefer Firebase"');
  expect(reconcile).toContain("do not\ninvent a new ranking or numeric weights");
});

// §13/§28: verify facts, don't invent incompatibilities; ctx is not a facts DB.
test("factual checking is taught and ctx is not a facts database", () => {
  expect(reconcile).toContain("do not\ninvent an incompatibility to dodge a preference");
  expect(reconcile).toContain("ctx is not a cloud-facts database");
});

// §14: concise exception explanation, never scores/memory dumps.
test("exception explanation is concise, never a score/memory dump", () => {
  expect(reconcile).toContain("If a meaningful exception was required, say so");
  expect(reconcile).toContain("never dump memories or scores");
});

// §7/§8/§9/§24/§25: exceptions recorded as evidence, never weaken the default; refinement.
test("§4 teaches exception recording, no preference change, and conditional refinement", () => {
  const signals = section(4);
  expect(signals).toContain("Exceptions — record WHY, never weaken the default");
  expect(signals).toContain("It does NOT change, weaken, or delete the preference");
  expect(signals).toContain("--preferred-choice firebase");
  expect(signals).toContain("--constraint free-tier --exception");
  expect(signals).toContain("reasons matter, not just counts");
  expect(signals).toContain("CONDITIONAL preference");
  expect(signals).toContain('ctx agent propose --origin user "Prefer Firebase when it fits cost/storage');
  // Contradictory exceptions: keep distinct reasons, propose nothing.
  expect(signals).toContain("If exceptions disagree");
  expect(signals).toContain("propose nothing — there is no single stable alternative");
});
