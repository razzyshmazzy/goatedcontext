/**
 * Deterministic RETRIEVAL corpus (retrieval pass, spec §14–§16).
 *
 * A focused, model-free evaluation of the retrieval ENGINE across the decision classes
 * the pull pilot stresses: DIRECT, OBLIQUE, PERSONAL/NAME, PROJECT-DECISION, EXPLICIT
 * ("ctx it"), and NEGATIVE. It is SEPARATE from the frozen v1.1 pull scenarios and the
 * held-out developer-memory benchmark — it tunes nothing against either (spec §18).
 *
 * Each relevant case carries TWO query forms for the same underlying request:
 *   - `probe`  — the raw, terse prompt (what a lazy agent passes verbatim), and
 *   - `query`  — the expanded, semantic query good query-construction produces.
 * Running both quantifies the VALUE of query construction (the expanded−probe recall
 * delta, spec §9/§E) independent of any model, while negatives measure engine precision.
 *
 * EXPLICIT cases model previous-turn inheritance (spec §7/§10): the literal command
 * "ctx it" is NOT a query and must retrieve nothing, while the inherited query (built
 * from the immediately-preceding request) retrieves the seed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCtx, retrieve as retrieveEnvelope, type Sandbox } from "./harness.ts";

export type CorpusClass = "direct" | "oblique" | "personal" | "project-decision" | "explicit" | "negative";

export interface CorpusSeed {
  rule: string;
  scope: "global" | "repo";
}

export interface CorpusCase {
  id: string;
  klass: CorpusClass;
  /** True when a stored preference SHOULD inform this request. */
  relevant: boolean;
  /** The raw, terse prompt an agent receives. For EXPLICIT cases this is the command. */
  probe: string;
  /** The expanded, semantic query good query-construction produces. */
  query: string;
  /** Preference to seed (relevant cases only). Deduped across the corpus before seeding. */
  seed?: CorpusSeed;
  /** Lowercase substrings; a retrieval "hit" = a returned rule contains any of them. */
  expect?: string[];
}

/** One seed per distinct decision, so seeds never conflict inside the shared store. */
export const CORPUS: CorpusCase[] = [
  // ---- DIRECT: the user names the decision outright ----
  {
    id: "D-package-manager", klass: "direct", relevant: true,
    probe: "What package manager do I use?",
    query: "package manager preference for this repository",
    seed: { rule: "Use pnpm as the package manager.", scope: "global" }, expect: ["pnpm"],
  },
  {
    id: "D-testing", klass: "direct", relevant: true,
    probe: "What testing framework do we use?",
    query: "testing framework and conventions for this repository",
    seed: { rule: "Use Vitest for unit tests.", scope: "global" }, expect: ["vitest"],
  },
  {
    id: "D-formatter", klass: "direct", relevant: true,
    probe: "What formatter is set up here?",
    query: "formatting and linting tool preference for this repository",
    seed: { rule: "Use Biome to format and lint code.", scope: "global" }, expect: ["biome"],
  },
  {
    id: "D-language", klass: "direct", relevant: true,
    probe: "What language do we script in?",
    query: "preferred language for writing scripts in this project",
    seed: { rule: "Use Python for data and scripting tasks.", scope: "global" }, expect: ["python"],
  },

  // ---- OBLIQUE: a terse task with a latent, unstated decision ----
  {
    id: "O-add-zod", klass: "oblique", relevant: true,
    probe: "Add zod.",
    query: "runtime schema / input validation library choice for this repo (zod)",
    seed: { rule: "Use zod for all runtime input validation.", scope: "global" }, expect: ["zod"],
  },
  {
    id: "O-safety-net", klass: "oblique", relevant: true,
    probe: "Give this module a safety net.",
    query: "testing framework and test-coverage conventions for this repository",
    seed: { rule: "Every module ships with Vitest unit tests before merge.", scope: "repo" }, expect: ["vitest"],
  },
  {
    id: "O-persistence", klass: "oblique", relevant: true,
    probe: "Set up persistence.",
    query: "database / persistence choice for production in this project",
    seed: { rule: "Use PostgreSQL for relational persistence.", scope: "global" }, expect: ["postgres", "postgresql"],
  },
  {
    id: "O-caching", klass: "oblique", relevant: true,
    probe: "Add caching.",
    query: "caching layer / architecture choice for this project",
    seed: { rule: "Use Redis for caching.", scope: "global" }, expect: ["redis"],
  },
  {
    id: "O-store", klass: "oblique", relevant: true,
    probe: "Add a store for shared state.",
    query: "client state management library choice for this app",
    seed: { rule: "Use Zustand for client state management.", scope: "global" }, expect: ["zustand"],
  },
  {
    id: "O-parse-log", klass: "oblique", relevant: true,
    probe: "Parse this log file.",
    query: "preferred language to parse and process log files in this project",
    seed: { rule: "Use Python to parse and process log files.", scope: "global" }, expect: ["python"],
  },

  // ---- PERSONAL / NAME: how the user wants to be addressed ----
  {
    id: "P-call-me", klass: "personal", relevant: true,
    probe: "What do you call me?",
    query: "the user's preferred name / how they want to be addressed",
    seed: { rule: "Call me Greg.", scope: "global" }, expect: ["greg"],
  },
  {
    id: "P-address", klass: "personal", relevant: true,
    probe: "How should you address me?",
    query: "how the user wants to be addressed / their preferred name",
    // same decision as P-call-me — no separate seed (deduped), shares "Call me Greg."
    expect: ["greg"],
  },

  // ---- PROJECT DECISION: a choice the project already settled ----
  {
    id: "J-auth", klass: "project-decision", relevant: true,
    probe: "What did we settle on for auth?",
    query: "authentication approach decided for this project (tokens, sessions)",
    seed: { rule: "Auth uses JWT access tokens with refresh-token rotation.", scope: "repo" }, expect: ["jwt", "token"],
  },
  {
    id: "J-errors", klass: "project-decision", relevant: true,
    probe: "How are errors represented here?",
    query: "error representation / error-handling convention in this repository",
    seed: { rule: "Errors are represented as a typed Result value and never thrown past the handler.", scope: "repo" },
    expect: ["result"],
  },
  {
    id: "J-api-shape", klass: "project-decision", relevant: true,
    probe: "Create another API endpoint.",
    query: "API endpoint response-shape convention for this repository",
    seed: { rule: "API endpoints return a { data, error } envelope and never throw past the handler.", scope: "repo" },
    expect: ["envelope", "{ data, error }"],
  },

  // ---- EXPLICIT: "ctx it" and friends — the command is NOT the query (spec §7/§10) ----
  // The probe (the literal command) must retrieve nothing; the inherited query does.
  {
    id: "X-ctx-it-name", klass: "explicit", relevant: true,
    probe: "ctx it",
    query: "the user's preferred name / how they want to be addressed",
    expect: ["greg"], // inherits the P-call-me decision
  },
  {
    id: "X-check-ctx-pm", klass: "explicit", relevant: true,
    probe: "check ctx",
    query: "package manager preference for this repository",
    expect: ["pnpm"], // inherits the D-package-manager decision
  },
  {
    id: "X-look-in-ctx-db", klass: "explicit", relevant: true,
    probe: "look in ctx",
    query: "database / persistence choice for production in this project",
    expect: ["postgres", "postgresql"], // inherits the O-persistence decision
  },

  // ---- NEGATIVE: general knowledge / explanation / preference-free tasks ----
  { id: "N-tcp", klass: "negative", relevant: false, probe: "Explain TCP slow start.", query: "Explain TCP slow start." },
  { id: "N-http404", klass: "negative", relevant: false, probe: "What does HTTP 404 mean?", query: "What does HTTP 404 mean?" },
  { id: "N-bigo", klass: "negative", relevant: false, probe: "What does Big-O notation mean?", query: "What does Big-O notation mean?" },
  { id: "N-mutex", klass: "negative", relevant: false, probe: "What is a mutex?", query: "What is a mutex?" },
  { id: "N-mvcc", klass: "negative", relevant: false, probe: "Explain MVCC.", query: "Explain MVCC." },
  { id: "N-array-map", klass: "negative", relevant: false, probe: "What does Array.map do?", query: "What does Array.map do?" },
  { id: "N-capital", klass: "negative", relevant: false, probe: "What's the capital of France?", query: "What's the capital of France?" },
  { id: "N-rebase", klass: "negative", relevant: false, probe: "Explain what a git rebase does.", query: "Explain what a git rebase does." },
  { id: "N-rename", klass: "negative", relevant: false, probe: "Rename this file to config.ts.", query: "Rename this file to config.ts." },
  { id: "N-typo", klass: "negative", relevant: false, probe: "Fix the typo in this comment.", query: "Fix the typo in this comment." },
];

/** Every distinct seed in the corpus, deduped by rule text (so no decision is double-seeded). */
export function corpusSeeds(cases: CorpusCase[] = CORPUS): CorpusSeed[] {
  const byRule = new Map<string, CorpusSeed>();
  for (const c of cases) if (c.seed && !byRule.has(c.seed.rule)) byRule.set(c.seed.rule, c.seed);
  return [...byRule.values()];
}

/** Create an isolated CTX_HOME + git repo and seed every corpus preference once. */
export function setupCorpusSandbox(): Sandbox {
  const ctxHome = mkdtempSync(join(tmpdir(), "ctxcorpus-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ctxcorpus-repo-"));
  const git = (a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/acme/retrieval-corpus.git"]);
  runCtx(["init"], ctxHome, repo);
  for (const seed of corpusSeeds()) {
    const r = runCtx(
      ["agent", "remember", seed.rule, "--origin", "user", "--scope", seed.scope, "--agent-id", "ctxcorpus"],
      ctxHome,
      repo,
    );
    if (r.code !== 0) throw new Error(`seed failed (${seed.rule}): ${r.stderr || r.stdout}`);
  }
  return {
    ctxHome, repo,
    settingsFile: "", shimDir: "", // unused for the deterministic engine pass
    cleanup: () => {
      rmSync(ctxHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

function hit(rules: string[], expect?: string[]): boolean {
  if (!expect || expect.length === 0) return rules.length > 0;
  return rules.some((r) => expect.some((e) => r.toLowerCase().includes(e.toLowerCase())));
}

export interface CaseResult {
  id: string;
  klass: CorpusClass;
  relevant: boolean;
  /** Recall with the RAW probe (no query construction). For negatives: did it wrongly surface? */
  probeHit: boolean;
  /** Recall with the EXPANDED query (good query construction). For negatives: wrongly surface? */
  queryHit: boolean;
  probeRuleCount: number;
  queryRuleCount: number;
}

export function runCorpus(sb: Sandbox, cases: CorpusCase[] = CORPUS): CaseResult[] {
  return cases.map((c) => {
    const probeRules = retrieveEnvelope(sb, c.probe).rules;
    const queryRules = retrieveEnvelope(sb, c.query).rules;
    return {
      id: c.id, klass: c.klass, relevant: c.relevant,
      probeHit: hit(probeRules, c.expect),
      queryHit: hit(queryRules, c.expect),
      probeRuleCount: probeRules.length,
      queryRuleCount: queryRules.length,
    };
  });
}

export interface CorpusSummary {
  relevant: number;
  negative: number;
  /** Relevant cases retrieved with the raw probe. */
  probeRecall: { num: number; den: number };
  /** Relevant cases retrieved with the expanded query (query-construction ON). */
  queryRecall: { num: number; den: number };
  /** Negatives that stayed clean with the raw probe. */
  probePrecision: { num: number; den: number };
  /** Negatives that stayed clean with the expanded query. */
  queryPrecision: { num: number; den: number };
  /** Per-class query recall for relevant classes. */
  byClass: Record<string, { num: number; den: number }>;
}

export function summarize(results: CaseResult[]): CorpusSummary {
  const rel = results.filter((r) => r.relevant);
  const neg = results.filter((r) => !r.relevant);
  const byClass: Record<string, { num: number; den: number }> = {};
  for (const r of rel) {
    byClass[r.klass] ??= { num: 0, den: 0 };
    byClass[r.klass]!.den++;
    if (r.queryHit) byClass[r.klass]!.num++;
  }
  return {
    relevant: rel.length,
    negative: neg.length,
    probeRecall: { num: rel.filter((r) => r.probeHit).length, den: rel.length },
    queryRecall: { num: rel.filter((r) => r.queryHit).length, den: rel.length },
    // For negatives, "hit" = wrongly surfaced something → clean = !hit.
    probePrecision: { num: neg.filter((r) => !r.probeHit).length, den: neg.length },
    queryPrecision: { num: neg.filter((r) => !r.queryHit).length, den: neg.length },
    byClass,
  };
}
