/**
 * Memory-bloat benchmark (0.4.0, spec §32 / amendment 16). Measurement only — never a
 * CI gate. Answers TWO SEPARATE questions, reported separately:
 *
 *   A. COMPUTATION scaling — does the engine stay fast as the store grows?
 *      (candidate SQL select, end-to-end retrieve, rendering)
 *   B. PROMPT-SIZE scaling — how big does the DELIVERED context get?
 *      (effective/delivered authoritative rules, rendered chars, approx tokens)
 *
 * at 100 / 1k / 10k / 50k stored preferences, across four distributions:
 * mostly-irrelevant, many-global-always, many-matching-conditional, realistic-mixed.
 *
 * The measured finding: retrieval remains bounded and usable at 50k stored preferences,
 * but reaches roughly 0.6–1.3 seconds across the mixed / always / irrelevant
 * distributions (a conditional-heavy store is slower still, ~1.8s) — usable for a
 * pathological store, not "cheap". In realistic mixed stores, PROMPT SIZE becomes the
 * practical constraint before SQLite correctness does: a store dominated by
 * user-authored ALWAYS rules renders a block too large to inject (many-global-always at
 * 50k delivers ~49,991 rules ≈ 3.21 MB ≈ 803k approx tokens). ctx does NOT prune it
 * silently — no semantic pruning, no embeddings/vector DB were added; authoritative
 * rules are never silently dropped. Omission happens only through the existing relevance
 * selection or an explicit caller-supplied budget, and is reported in the diagnostics.
 *
 *   bun run scripts/bench/memory-bloat.ts [--json out.json]
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../../src/storage/sqlite/db.ts";
import { resolvePaths } from "../../src/storage/paths.ts";
import { CtxContext } from "../../src/core/context.ts";
import { FileSecretStore } from "../../src/storage/secrets/file-backend.ts";
import { buildContextEnvelope } from "../../src/core/agents/envelope.ts";
import { isCanonicalDomain } from "../../src/core/signals/domains.ts";
import { bulkSeed, type GeneratedDataset, type PrefSpec, generateDataset } from "../../tests/bench/fixtures.ts";

const SIZES = [100, 1_000, 10_000, 50_000];
const TASK = "design the database schema with indexes";

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return +(s[Math.floor(s.length / 2)] ?? 0).toFixed(3);
}
function ctxFor(dir: string): CtxContext {
  const paths = resolvePaths({ CTX_HOME: dir });
  const db = openMemoryDatabase();
  const secrets = new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
  return CtxContext.fromParts(paths, { version: 1, createdAt: "2026-01-01T00:00:00.000Z", retrievalLimit: 12 }, db, secrets);
}

/** Build a scenario-specific dataset of `count` GLOBAL preferences (no repos needed). */
function scenarioDataset(name: string, count: number): GeneratedDataset {
  if (name === "realistic-mixed") return generateDataset(count, { seed: 7, repoCount: 50 });
  const prefs: PrefSpec[] = [];
  for (let i = 0; i < count; i++) {
    if (name === "many-global-always") {
      prefs.push({ rule: `Always follow team rule number ${i} about topic ${i % 200}.`, category: "general", scope: "global", status: "approved", applicability: "always", condition: null });
    } else if (name === "mostly-irrelevant") {
      // Relevant rules about formatting/naming — unrelated to a database task, so few match.
      prefs.push({ rule: `Prefer naming style ${i % 7} for identifiers ${i}.`, category: "formatting", scope: "global", status: "approved", applicability: "relevant", condition: null });
    } else {
      // many-matching-conditional: all conditional on language=typescript (the query matches).
      prefs.push({ rule: `Use helper pattern ${i} when applicable.`, category: "architecture", scope: "global", status: "approved", applicability: "conditional", condition: { language: "typescript" } });
    }
  }
  return { prefs, repoIdentities: [] };
}

function run(name: string, count: number) {
  const dir = mkdtempSync(join(tmpdir(), "bloat-"));
  const ctx = ctxFor(dir);
  try {
    bulkSeed(ctx.db, scenarioDataset(name, count));
    const q = { cwd: "/x", task: TASK, languages: ["typescript"], track: false as const, explain: true as const };

    // A. computation
    const candidateMs = median(Array.from({ length: 10 }, () => time(() => void ctx.preferences.listCandidates({ repoId: null }))));
    const cold = time(() => void ctx.retrieval.retrieve(q));
    const iters = count >= 50_000 ? 15 : 60;
    const retrieveMs = median(Array.from({ length: iters }, () => time(() => void ctx.retrieval.retrieve(q))));
    const result = ctx.retrieval.retrieve(q);
    const renderMs = median(Array.from({ length: iters }, () => time(() => void buildContextEnvelope(result, { isCanonicalDomain }))));

    // B. prompt-size (from the stable envelope diagnostics)
    const env = buildContextEnvelope(result, { isCanonicalDomain });
    const d = env.meta.diagnostics;

    return {
      scenario: name,
      prefs: count,
      // A — computation (ms)
      computation: { candidateSelectMs: candidateMs, retrieveColdMs: +cold.toFixed(3), retrieveWarmMs: retrieveMs, renderEnvelopeMs: renderMs },
      // B — prompt size
      promptSize: {
        effectiveAuthoritative: d.effective,
        deliveredAuthoritative: d.delivered,
        renderedChars: d.renderedChars,
        approxTokens: d.approxTokens,
        omittedByRelevance: d.omittedByRelevance,
        omittedByBudget: d.omittedByBudget,
        overflow: d.overflow,
      },
    };
  } finally {
    ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows: ReturnType<typeof run>[] = [];
for (const name of ["mostly-irrelevant", "many-global-always", "many-matching-conditional", "realistic-mixed"]) {
  for (const size of SIZES) rows.push(run(name, size));
}

const result = {
  env: { platform: process.platform, node: process.version, bun: (globalThis as { Bun?: { version: string } }).Bun?.version ?? null },
  note: "A (computation) and B (prompt size) are SEPARATE. At 50k, retrieveWarmMs is ~0.6-1.3s for mixed/always/irrelevant (conditional-heavy ~1.8s) — bounded/usable, not cheap. In many-global-always, renderedChars/approxTokens grow until the block is too large to inject — a prompt-size limit reached before a DB limit. No semantic pruning; authoritative rules are never silently dropped; omission comes only from relevance selection or an explicit budget and is reported.",
  rows,
};

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  writeFileSync(process.argv[jsonFlag + 1]!, JSON.stringify(result, null, 2));
  console.log(`wrote ${process.argv[jsonFlag + 1]}`);
}
console.log(JSON.stringify(result, null, 2));
