/**
 * Focused RETRIEVAL-ENGINE corpus (engine pass, spec §9–§11).
 *
 * Unlike the pull/oblique corpora (which ask "should the agent CALL ctx?"), this one
 * stresses the ENGINE directly: given a realistic, already-formed query, does lexical +
 * domain + intent retrieval return the RIGHT stored memory and NOTHING it shouldn't?
 *
 * ALL seeds live in ONE store, so every query runs against the full set — same-domain
 * distractors (three `infrastructure` memories), multiple candidates, global vs repo
 * scope, and negative-polarity rules are all present at once. That is what makes the
 * precision numbers (adjacent-topic, unrelated, candidate-set size, top-1) meaningful
 * rather than one-seed-in-isolation theatre.
 *
 * Classes:
 *   - morphology      : query noun-form vs rule verb-form (deployment↔deploy)
 *   - semantic        : query names the generic decision, rule names the choice
 *   - proper-noun     : query cannot name the product; must abstract to the domain
 *   - adjacent-neg    : conceptual question ABOUT an entity we store a preference for
 *   - unrelated-neg   : general knowledge with no stored preference at all
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCtx, retrieve as retrieveEnvelope, type Sandbox } from "./harness.ts";

export type SemClass = "morphology" | "semantic" | "proper-noun" | "adjacent-neg" | "unrelated-neg";

export interface SemSeed {
  id: string;
  rule: string;
  scope: "global" | "repo";
}

/** The stored memories. IDs let a case point at the ONE rule it expects (top-1 truth). */
export const SEM_SEEDS: SemSeed[] = [
  { id: "flyio", rule: "Deploy this app to Fly.io.", scope: "global" },
  { id: "bullmq", rule: "Use BullMQ for background jobs.", scope: "global" },
  { id: "redis", rule: "Prefer Redis for caching.", scope: "global" },
  { id: "vitest", rule: "Use Vitest for unit tests.", scope: "global" },
  { id: "postgres", rule: "Prefer Postgres in production.", scope: "global" },
  { id: "pnpm", rule: "Use pnpm as the package manager.", scope: "global" },
  { id: "auth", rule: "Keep auth server-side with session cookies.", scope: "repo" },
  { id: "pino", rule: "Use structured logging with pino.", scope: "global" },
  { id: "zustand", rule: "Use Zustand for client state.", scope: "global" },
  { id: "biome", rule: "Format and lint with Biome.", scope: "global" },
  // negative-polarity rules (must still be retrievable by their subject). Phrased so they
  // stay `relevant` (not `always`) — a leading "Never…"/"Always…" would make the rule
  // apply to every turn, which is correct product behavior but would mask per-query scoring.
  { id: "no-var", rule: "Do not use the var keyword; prefer const or let.", scope: "global" },
  { id: "no-any", rule: "Avoid the any type; prefer precise types.", scope: "repo" },
];

export interface SemCase {
  id: string;
  klass: SemClass;
  query: string;
  /** For positives: the seed id that SHOULD rank first / be present. */
  expect?: string;
  /** For adjacent negatives: the seed id that must NOT be returned. */
  forbid?: string;
}

export const SEM_CASES: SemCase[] = [
  // ---- MORPHOLOGY: query uses a derived form of the rule's word ----
  { id: "m-deployment", klass: "morphology", query: "deployment convention for this repo", expect: "flyio" },
  { id: "m-persistence", klass: "morphology", query: "set up production persistence", expect: "postgres" },
  { id: "m-testing", klass: "morphology", query: "add testing for this module", expect: "vitest" },
  { id: "m-caching", klass: "morphology", query: "configure a caching layer", expect: "redis" },
  { id: "m-logging", klass: "morphology", query: "add structured logging", expect: "pino" },
  { id: "m-formatting", klass: "morphology", query: "set up formatting and linting", expect: "biome" },

  // ---- SEMANTIC: query names the generic decision, rule names the choice ----
  { id: "s-state", klass: "semantic", query: "what should we use for client state management", expect: "zustand" },
  { id: "s-pm", klass: "semantic", query: "install another dependency", expect: "pnpm" },
  { id: "s-auth", klass: "semantic", query: "add login and authentication", expect: "auth" },
  { id: "s-types", klass: "semantic", query: "tighten the type annotations here", expect: "no-any" },

  // ---- PROPER-NOUN: query cannot know the product; must abstract to the domain ----
  { id: "p-queue", klass: "proper-noun", query: "add a job queue", expect: "bullmq" },
  { id: "p-cache", klass: "proper-noun", query: "set up caching", expect: "redis" },
  { id: "p-deploy", klass: "proper-noun", query: "how should we deploy to production", expect: "flyio" },
  { id: "p-test", klass: "proper-noun", query: "pick a test runner", expect: "vitest" },
  { id: "p-db", klass: "proper-noun", query: "add a relational database layer", expect: "postgres" },

  // ---- ADJACENT NEGATIVES: conceptual question about an entity we have a pref for ----
  { id: "a-redis", klass: "adjacent-neg", query: "explain how Redis eviction works", forbid: "redis" },
  { id: "a-queue", klass: "adjacent-neg", query: "what is a queue?", forbid: "bullmq" },
  { id: "a-logging", klass: "adjacent-neg", query: "what is structured logging?", forbid: "pino" },
  { id: "a-mvcc", klass: "adjacent-neg", query: "explain Postgres MVCC", forbid: "postgres" },
  { id: "a-flyio", klass: "adjacent-neg", query: "what is Fly.io?", forbid: "flyio" },
  { id: "a-oauth", klass: "adjacent-neg", query: "how does OAuth work?", forbid: "auth" },
  { id: "a-zustand", klass: "adjacent-neg", query: "what is Zustand?", forbid: "zustand" },

  // ---- UNRELATED NEGATIVES: general knowledge, no stored preference ----
  { id: "u-france", klass: "unrelated-neg", query: "what is the capital of France?" },
  { id: "u-tcp", klass: "unrelated-neg", query: "explain TCP slow start" },
  { id: "u-map", klass: "unrelated-neg", query: "what does Array.map do?" },
  { id: "u-tls", klass: "unrelated-neg", query: "how does TLS work?" },
  { id: "u-closure", klass: "unrelated-neg", query: "what is a closure?" },
];

/** Create an isolated CTX_HOME + git repo and seed every semantic-corpus rule once. */
export function setupSemanticSandbox(): Sandbox {
  const ctxHome = mkdtempSync(join(tmpdir(), "ctxsem-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ctxsem-repo-"));
  const git = (a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/acme/semantic-corpus.git"]);
  runCtx(["init"], ctxHome, repo);
  for (const s of SEM_SEEDS) {
    const r = runCtx(
      ["agent", "remember", s.rule, "--origin", "user", "--scope", s.scope, "--agent-id", "ctxsem"],
      ctxHome,
      repo,
    );
    if (r.code !== 0) throw new Error(`seed failed (${s.rule}): ${r.stderr || r.stdout}`);
  }
  return {
    ctxHome,
    repo,
    settingsFile: "",
    shimDir: "",
    cleanup: () => {
      rmSync(ctxHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

/** Does any returned rule contain the seed's distinctive text? (matches by seed rule). */
function returnedIds(rules: string[]): Set<string> {
  const ids = new Set<string>();
  for (const s of SEM_SEEDS) {
    // A seed is "returned" when a delivered rule equals its stored rule (case-insensitive).
    if (rules.some((r) => r === s.rule.toLowerCase())) ids.add(s.id);
  }
  return ids;
}

export interface SemResult {
  id: string;
  klass: SemClass;
  /** Positives: expected seed present. Negatives: n/a. */
  recalled: boolean | null;
  /** Positives: expected seed ranked #1. */
  top1: boolean | null;
  /** Negatives: forbidden/any seed wrongly surfaced. */
  leaked: boolean | null;
  /** Number of preferences returned (candidate-set size proxy). */
  returnedCount: number;
}

export function runSemantic(sb: Sandbox, cases: SemCase[] = SEM_CASES): SemResult[] {
  return cases.map((c) => {
    const env = retrieveEnvelope(sb, c.query);
    const rules = env.rules; // already lowercased, in relevance order
    const ids = returnedIds(rules);
    const positive = c.klass === "morphology" || c.klass === "semantic" || c.klass === "proper-noun";
    if (positive) {
      const recalled = c.expect ? ids.has(c.expect) : false;
      const top1 = c.expect ? rules.length > 0 && rules[0] === seedRule(c.expect) : false;
      return { id: c.id, klass: c.klass, recalled, top1, leaked: null, returnedCount: rules.length };
    }
    // negative
    const leaked = c.klass === "adjacent-neg" ? (c.forbid ? ids.has(c.forbid) : rules.length > 0) : rules.length > 0;
    return { id: c.id, klass: c.klass, recalled: null, top1: null, leaked, returnedCount: rules.length };
  });
}

function seedRule(id: string): string {
  return (SEM_SEEDS.find((s) => s.id === id)?.rule ?? "").toLowerCase();
}

export interface SemSummary {
  morphologyRecall: { num: number; den: number };
  semanticRecall: { num: number; den: number };
  properNounRecall: { num: number; den: number };
  adjacentPrecision: { num: number; den: number };
  unrelatedPrecision: { num: number; den: number };
  top1: { num: number; den: number };
  avgCandidates: number;
  falsePositiveRate: { num: number; den: number };
}

function frac(num: number, den: number) {
  return { num, den };
}

export function summarizeSemantic(results: SemResult[]): SemSummary {
  const by = (k: SemClass) => results.filter((r) => r.klass === k);
  const pos = results.filter((r) => r.recalled !== null);
  const neg = results.filter((r) => r.leaked !== null);
  const adj = by("adjacent-neg");
  const unrel = by("unrelated-neg");
  const recallOf = (k: SemClass) => {
    const cs = by(k);
    return frac(cs.filter((r) => r.recalled).length, cs.length);
  };
  return {
    morphologyRecall: recallOf("morphology"),
    semanticRecall: recallOf("semantic"),
    properNounRecall: recallOf("proper-noun"),
    adjacentPrecision: frac(adj.filter((r) => !r.leaked).length, adj.length),
    unrelatedPrecision: frac(unrel.filter((r) => !r.leaked).length, unrel.length),
    top1: frac(pos.filter((r) => r.top1).length, pos.length),
    avgCandidates: pos.length ? pos.reduce((a, r) => a + r.returnedCount, 0) / pos.length : 0,
    falsePositiveRate: frac(neg.filter((r) => r.leaked).length, neg.length),
  };
}
