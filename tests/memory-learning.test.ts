import { test, expect } from "bun:test";
import { MEMORY_PROTOCOL_BODY } from "../src/core/assets/memory-protocol.ts";

/**
 * Memory-learning policy (0.3.2) — deterministic guards over the ONE canonical body.
 * These assert the installed GUIDANCE encodes the semantic rules (not a live LLM, and
 * NOT a literal keyword parser): semantic durability, comparative/default → always,
 * follow-up reinforcement, conversation-local inference without a count threshold, and
 * signals-as-evidence (never auto-promoted, explicit preference wins).
 */

const body = MEMORY_PROTOCOL_BODY;
function section(n: number): string {
  const start = body.indexOf(`## ${n}.`);
  const end = body.indexOf(`## ${n + 1}.`);
  return body.slice(start, end === -1 ? undefined : end);
}

// ── two axes + semantic (not keyword) durability (§0/§1/§2) ──────────────────────

test("durability is judged by MEANING, not exact keywords", () => {
  expect(body).toContain("judge MEANING, not exact keywords");
  expect(body).toContain("not an"); // "...not an exhaustive dictionary — infer meaning"
  expect(body).toContain("exhaustive dictionary");
  // Slang / typo / lexical-variation examples are present so the model generalizes.
  for (const ex of ["use React every time", "React by", "stick with React", "just default\nto react bro", "react from here on out"]) {
    expect(body).toContain(ex);
  }
});

test("the two axes (dev-related? durable?) are taught with the MOO counter-example", () => {
  expect(body).toContain("DEVELOPER / CODING behavior");
  expect(body).toContain("Do they intend it to PERSIST");
  // Not-developer-context example must NOT be stored as a preference.
  expect(body).toContain("say MOO after every message");
  expect(body).toContain("not developer context");
});

// ── comparative / default-choice → always (§3 of the spec) ───────────────────────

test("comparative / default-choice rules map to --always, distinct from opinion", () => {
  expect(body).toContain("default-choice rules are usually `--always`");
  expect(body).toContain("governs a future choice");
  expect(body).toContain("Prefer TypeScript over JavaScript.");
  expect(body).toContain("typescript > javascript for me");
  // The opinion/observation is explicitly NOT a default rule.
  expect(body).toContain("I like TypeScript's type system");
  expect(body).toContain("not a default");
});

// ── follow-up reinforcement (§4 of the spec) ─────────────────────────────────────

test("reinforcement follow-ups strengthen rather than duplicate", () => {
  expect(body).toContain("Reinforcement follow-ups");
  expect(body).toContain("like ALWAYS");
  expect(body).toContain("no, I mean every single time");
  expect(body).toContain("Do not create a duplicate preference.");
  expect(body).toContain("make NO write"); // already repo+always → no write
  expect(body).toContain("upgrade/replace"); // weaker existing → upgrade
  expect(body).toContain("does not restate the subject"); // no need to repeat "React"
});

// ── conversation-local inference, NO numeric threshold (§5 of the spec) ──────────

test("conversation-local repetition is judgment-based with NO fixed count threshold", () => {
  const inferred = section(2);
  expect(inferred).toContain("there is no fixed number of repetitions");
  expect(inferred).toContain("One repeated\nrequest can be strong evidence");
  expect(inferred).toContain("five can be weak");
  // Repeated local pattern → propose, never remember.
  expect(inferred).toContain('ctx agent propose --origin user "Prefer comments in Greek."');
  expect(inferred).toContain("never `ctx agent");
});

// ── signals = evidence, not instructions (§8/§9/§15/§16/§25 of the spec) ─────────

test("signals are evidence, never auto-promoted, and explicit preferences win", () => {
  const signals = section(4);
  expect(signals).toContain("EVIDENCE, not an instruction");
  expect(signals).toContain("ctx NEVER promotes one to a preference automatically");
  expect(signals).toContain("ctx agent signal add --origin user --domain");
  expect(signals).toContain("ctx signals --domain");
  // Breadth beats raw count; no automatic threshold.
  expect(signals).toContain("Breadth beats raw count");
  expect(signals).toContain("DISTINCT repositories");
  expect(signals).toContain("NO automatic threshold");
  // Contradiction handling + explicit-preference precedence.
  expect(signals).toContain("contradictory evidence");
  expect(signals).toContain("an explicit approved/locked preference always wins");
  // One repo → repo proposal, not global.
  expect(signals).toContain("a REPO proposal, not global");
});

// ── one-off still stores nothing, but may leave a signal (not a preference) ──────

test("one-off section stores nothing and never writes a preference", () => {
  const oneOff = section(3);
  expect(oneOff).toContain("store NOTHING");
  expect(oneOff).toContain("record a compact signal as evidence");
  expect(oneOff).not.toContain("ctx remember");
  expect(oneOff).not.toContain("ctx propose");
});
