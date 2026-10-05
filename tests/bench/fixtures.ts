/**
 * Deterministic, seeded dataset generation for scale / cache / concurrency
 * diagnostics (0.3.0 phase). NO randomness without a seed — every dataset is
 * reproducible so correctness assertions never flake.
 *
 * Two seeding paths:
 *   - `bulkSeed`   — one write transaction, direct INSERTs. Fast enough for
 *     10k–100k rows. Field computation MIRRORS PreferenceService.remember exactly
 *     (same analysis helpers, same dedup_key formula) so retrieval sees identical
 *     data to a real insert. Used by scale benchmarks.
 *   - `seedViaService` — inserts through ctx.preferences.remember/propose. Slower
 *     (one tx each) but the production path; used by smaller correctness tests.
 *
 * This file touches NO production code — it only consumes exported pure helpers.
 */
import type { CtxContext } from "../../src/core/context.ts";
import type { Database } from "../../src/storage/sqlite/driver.ts";
import { withWriteTx } from "../../src/storage/sqlite/tx.ts";
import { newId } from "../../src/utils/id.ts";
import {
  polarity as detectPolarity,
  inferPrimaryDomain,
  subjectKey,
} from "../../src/core/preferences/analysis.ts";
import {
  conditionToCanonicalJson,
  type Condition,
} from "../../src/core/preferences/conditions.ts";
import type { Applicability, Scope, Status } from "../../src/core/preferences/types.ts";

/** Mulberry32 — a tiny deterministic PRNG. No dependency, fully reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length]!;
}

export interface PrefSpec {
  rule: string;
  category: string;
  scope: Scope;
  /** Index into the generated repo identities; only meaningful for scope==="repo". */
  repoIndex?: number;
  status: Status;
  applicability: Applicability;
  condition: Condition | null;
  domain?: string | null;
}

export interface GeneratedDataset {
  prefs: PrefSpec[];
  /** Distinct repo identities the dataset references (repoIndex -> identity). */
  repoIdentities: string[];
}

const CATEGORIES = ["general", "testing", "database", "dependencies", "formatting", "architecture", "error-handling", "infrastructure"];
const LANGUAGES = ["typescript", "javascript", "python", "go", "rust", "java"];
const DOMAINS_FOR_COND = ["database", "testing", "architecture", "formatting", "infrastructure"];
const SUBJECTS = [
  "foreign keys", "indexes", "transactions", "retries", "timeouts", "logging",
  "pagination", "validation", "caching layers", "rate limiting", "feature flags",
  "dependency injection", "pure functions", "immutability", "early returns",
  "exhaustive switches", "error wrapping", "structured logs", "idempotency",
  "backoff", "circuit breakers", "connection reuse", "schema versioning",
];
const VERBS_POS = ["Prefer", "Use", "Favor", "Adopt", "Standardize on"];
const VERBS_NEG = ["Avoid", "Never use", "Do not rely on"];

/**
 * Deterministically generate a realistic mixture of preferences:
 * global/repo × always/relevant/conditional × approved/locked/proposed/rejected,
 * with nested conditions, conflicting pairs, long/short/duplicate-ish text, and
 * semantically-unrelated noise. Reproducible for a given (count, seed, repoCount).
 */
export function generateDataset(count: number, opts: { seed?: number; repoCount?: number } = {}): GeneratedDataset {
  const seed = opts.seed ?? 1234;
  const repoCount = Math.max(1, opts.repoCount ?? Math.max(1, Math.min(count, 10)));
  const r = rng(seed);
  const repoIdentities = Array.from({ length: repoCount }, (_, i) => `remote:github.com/acme/repo-${i}`);
  const prefs: PrefSpec[] = [];

  for (let i = 0; i < count; i++) {
    const roll = r();
    const scope: Scope = r() < 0.5 ? "global" : "repo";
    const repoIndex = scope === "repo" ? Math.floor(r() * repoCount) : undefined;
    const subject = pick(r, SUBJECTS);
    const long = r() < 0.08;
    const verb = r() < 0.75 ? pick(r, VERBS_POS) : pick(r, VERBS_NEG);

    let applicability: Applicability;
    let condition: Condition | null = null;
    let rule: string;
    let category = pick(r, CATEGORIES);
    let status: Status;

    // Applicability mixture: ~15% always, ~25% conditional, ~60% relevant.
    if (roll < 0.15) {
      applicability = "always";
      rule = `Always ${verb.toLowerCase()} ${subject}${scope === "repo" ? " in this repo" : ""}.`;
    } else if (roll < 0.4) {
      applicability = "conditional";
      const kind = r();
      if (kind < 0.3) condition = { language: pick(r, LANGUAGES) };
      else if (kind < 0.55) condition = { file: `**/*.${pick(r, ["ts", "tsx", "py", "go", "rs"])}` };
      else if (kind < 0.75) condition = { domain: pick(r, DOMAINS_FOR_COND) };
      else if (kind < 0.9)
        // nested all/any
        condition = { all: [{ language: pick(r, LANGUAGES) }, { domain: pick(r, DOMAINS_FOR_COND) }] };
      else condition = { not: { language: pick(r, LANGUAGES) } };
      rule = `${verb} ${subject} when applicable.`;
    } else {
      applicability = "relevant";
      rule = long
        ? `${verb} ${subject}. ` + `This preference carries extended rationale about ${subject} and ${pick(r, SUBJECTS)} `.repeat(6).trim() + "."
        : `${verb} ${subject}.`;
    }

    // Status mixture: ~70% approved, ~10% locked, ~12% proposed, ~8% rejected.
    const s = r();
    if (s < 0.7) status = "approved";
    else if (s < 0.8) status = "locked";
    else if (s < 0.92) status = "proposed";
    else status = "rejected";
    // proposed/observed may not be always/conditional-with-condition issues? They can.
    // But a proposed conditional still needs a condition — already set above.

    // Pure noise: semantically-unrelated short rules in a random category.
    if (r() < 0.2) {
      rule = `Prefer ${pick(r, ["kebab-case", "snake_case", "camelCase", "PascalCase"])} for ${pick(r, ["files", "ids", "columns", "routes", "events"])}.`;
      category = "formatting";
      applicability = "relevant";
      condition = null;
    }

    prefs.push({ rule, category, scope, repoIndex, status, applicability, condition });
  }

  // Inject deterministic CONFLICTING pairs on an exclusive domain (package-manager):
  // one global "prefer pnpm", one repo-0 "use npm" — precedence must resolve them.
  prefs.push(
    { rule: "Prefer pnpm as the package manager.", category: "dependencies", scope: "global", status: "approved", applicability: "always", condition: null },
    { rule: "Use npm as the package manager in this repo.", category: "dependencies", scope: "repo", repoIndex: 0, status: "approved", applicability: "always", condition: null },
  );

  return { prefs, repoIdentities };
}

/** The dedup_key formula — byte-identical to PreferenceService.dedupKey (private). */
function dedupKey(scope: Scope, repoId: string | null, rule: string, pol: string, condition: Condition | null): string {
  const base = `${scope}|${repoId ?? ""}|${subjectKey(rule)}|${pol}`;
  return condition ? `${base}|${conditionToCanonicalJson(condition)}` : base;
}

export interface SeedResult {
  /** Local repo ids by repoIndex (so tests can resolve repo-scoped expectations). */
  repoIds: string[];
  count: number;
}

/**
 * Fast bulk seed: ensure repo rows, then insert all preferences in ONE write
 * transaction. Field derivation mirrors PreferenceService.remember exactly.
 */
export function bulkSeed(db: Database, dataset: GeneratedDataset): SeedResult {
  const ts = "2026-01-01T00:00:00.000Z";
  return withWriteTx(db, () => {
    // Repos.
    const repoIds: string[] = [];
    const repoStmt = db.query(
      `INSERT INTO repos (id, identity, name, remote_url, root_path, has_remote, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(identity) DO NOTHING`,
    );
    const getRepo = db.query<{ id: string }, [string]>("SELECT id FROM repos WHERE identity = ?");
    dataset.repoIdentities.forEach((identity, i) => {
      const id = newId();
      repoStmt.run(id, identity, `repo-${i}`, `https://${identity.slice(7)}.git`, `/virtual/repo-${i}`, ts, ts);
      repoIds.push(getRepo.get(identity)!.id);
    });

    const insert = db.query(
      `INSERT INTO preferences
         (id, rule, normalized, category, domain, polarity, scope, repo_id, status,
          applicability, condition_json, confidence, version, created_at, updated_at, last_used_at, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`,
    );
    // Monotonic createdAt so ordering is deterministic across the dataset.
    let n = 0;
    for (const p of dataset.prefs) {
      const repoId = p.scope === "repo" ? repoIds[p.repoIndex ?? 0]! : null;
      const pol = detectPolarity(p.rule);
      const domain = p.domain ?? inferPrimaryDomain(p.rule, p.category);
      const cond = p.condition;
      const createdAt = `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.${String(n % 1000).padStart(3, "0")}Z`;
      insert.run(
        newId(),
        p.rule,
        subjectKey(p.rule),
        p.category,
        domain,
        pol,
        p.scope,
        repoId,
        p.status,
        p.applicability,
        cond ? conditionToCanonicalJson(cond) : null,
        1.0,
        createdAt,
        createdAt,
        // proposed/observed rows participate in the unique dedup index; give each a
        // unique key by appending its id so bulk noise never collides on that index.
        (p.status === "proposed" || p.status === "observed")
          ? dedupKey(p.scope, repoId, p.rule, pol, cond) + "|" + n
          : dedupKey(p.scope, repoId, p.rule, pol, cond),
      );
      n++;
    }
    return { repoIds, count: n };
  });
}

/** A single planted sentinel preference (used to assert retrieval finds a needle in noise). */
export interface Sentinel extends PrefSpec {
  rule: string;
}

/** Insert one sentinel via the real service path, returning its id. */
export function plantSentinel(ctx: CtxContext, s: Sentinel, repoId: string | null): string {
  const pref = ctx.preferences.remember({
    rule: s.rule,
    category: s.category,
    scope: s.scope,
    repoId,
    status: s.status === "locked" ? "locked" : "approved",
    applicability: s.applicability,
    condition: s.condition,
  });
  return pref.id;
}
