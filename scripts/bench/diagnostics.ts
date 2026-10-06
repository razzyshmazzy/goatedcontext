/**
 * 0.3.0 diagnostic BENCHMARKS (measurement only — never a CI gate).
 *
 *   bun run scripts/bench/diagnostics.ts            # human table + JSON to stdout
 *   bun run scripts/bench/diagnostics.ts --json out.json
 *
 * Measures: retrieval scaling (cold/warm/p95/p99), startup latency (real processes),
 * DB open/close cost, export/import timing, and DB size / history growth. Uses the
 * same deterministic fixtures as the tests. Numbers are machine-specific — the report
 * records the environment.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase, openDatabase } from "../../src/storage/sqlite/db.ts";
import { resolvePaths } from "../../src/storage/paths.ts";
import { CtxContext } from "../../src/core/context.ts";
import { FileSecretStore } from "../../src/storage/secrets/file-backend.ts";
import { exportData, importData } from "../../src/core/transfer/transfer.ts";
import { generateDataset, bulkSeed } from "../../tests/bench/fixtures.ts";
import { withWriteTx } from "../../src/storage/sqlite/tx.ts";
import { newId } from "../../src/utils/id.ts";
import { whichSync } from "../../src/utils/runtime.ts";

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}
function stat(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { median: +pct(s, 50).toFixed(3), p95: +pct(s, 95).toFixed(3), p99: +pct(s, 99).toFixed(3) };
}
function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function ctxFor(dir: string): CtxContext {
  const paths = resolvePaths({ CTX_HOME: dir });
  const db = openMemoryDatabase();
  const secrets = new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
  return CtxContext.fromParts(paths, { version: 1, createdAt: "2026-01-01T00:00:00.000Z", retrievalLimit: 12 }, db, secrets);
}

function benchRetrievalScaling() {
  const rows: Record<string, unknown>[] = [];
  for (const count of [1_000, 10_000, 50_000]) {
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    const ctx = ctxFor(dir);
    try {
      bulkSeed(ctx.db, generateDataset(count, { seed: 1, repoCount: 50 }));
      const active = ctx.preferences.list().filter((p) => p.status === "approved" || p.status === "locked").length;
      // No-repo context (cwd=/x): the SQL candidate set is globals-active only — far
      // fewer rows than the full active pool, which is the D2 reduction even here.
      const sqlCandidates = ctx.preferences.listCandidates({ repoId: null }).length;
      const q = { cwd: "/x", task: "design the database schema with indexes", languages: ["typescript"], track: false as const };
      const cold = time(() => void ctx.retrieval.retrieve(q));
      const iters = count >= 50_000 ? 40 : 150;
      const warm: number[] = [];
      let resultCount = 0;
      for (let i = 0; i < iters; i++) warm.push(time(() => (resultCount = ctx.retrieval.retrieve(q).preferences.length)));
      rows.push({ prefs: count, activeCandidates: active, sqlCandidates, resultCount, coldMs: +cold.toFixed(3), warm: stat(warm), iters });
    } finally {
      ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return rows;
}

/**
 * D2 before/after: in a MANY-REPO store, retrieving one repo's context used to load
 * + map every row (`list()` full scan + JS filter). The new `listCandidates` pushes
 * the status + scope/repo filter into SQL so only globals + this repo are loaded.
 * Measures candidate COUNT and candidate-build time for both paths, plus full
 * retrieve() time (which now uses the reduced path).
 */
function benchCandidateReduction() {
  const rows: Record<string, unknown>[] = [];
  const ACTIVE = new Set(["approved", "locked"]);
  for (const count of [10_000, 50_000]) {
    const dir = mkdtempSync(join(tmpdir(), "bench-cand-"));
    const ctx = ctxFor(dir);
    try {
      const { repoIds } = bulkSeed(ctx.db, generateDataset(count, { seed: 5, repoCount: 100 }));
      const repoId = repoIds[0]!;
      const total = ctx.preferences.list().length;

      // OLD path: full list() + JS filter (status + scope/repo), replicated exactly.
      let oldCount = 0;
      const oldSamples: number[] = [];
      for (let i = 0; i < 30; i++) {
        oldSamples.push(
          time(() => {
            oldCount = ctx.preferences
              .list()
              .filter((p) => ACTIVE.has(p.status) && (p.scope === "global" || (p.scope === "repo" && p.repoId === repoId)))
              .length;
          }),
        );
      }

      // NEW path: SQL-reduced candidate set.
      let newCount = 0;
      const newSamples: number[] = [];
      for (let i = 0; i < 30; i++) {
        newSamples.push(time(() => (newCount = ctx.preferences.listCandidates({ repoId }).length)));
      }

      // Full retrieve() for the same repo context (uses the reduced path now).
      const q = { cwd: "/x", task: "design the database schema with indexes", languages: ["typescript"], track: false as const, domain: null };
      void ctx.retrieval.retrieve(q); // warm page cache
      const retrieveSamples: number[] = [];
      for (let i = 0; i < 30; i++) retrieveSamples.push(time(() => void ctx.retrieval.retrieve(q)));

      // Both paths return the SAME candidate set (oracle parity → identical counts);
      // the win is that the OLD path LOADS + maps all `total` rows while the NEW path
      // loads only the `newCount` eligible rows. So the meaningful reduction is rows
      // materialized (newCount vs total), reflected in the candidate-build speedup.
      const oldBuild = stat(oldSamples);
      const newBuild = stat(newSamples);
      rows.push({
        prefs: total,
        repos: 100,
        candidateCount: newCount, // == oldCount (parity)
        parityOk: oldCount === newCount,
        rowsLoadedOld: total,
        rowsLoadedNew: newCount,
        rowsReductionPct: +(100 * (1 - newCount / total)).toFixed(1),
        oldCandidateBuildMs: oldBuild,
        newCandidateBuildMs: newBuild,
        candidateBuildSpeedup: +(oldBuild.median / newBuild.median).toFixed(2),
        retrieveMs: stat(retrieveSamples),
      });
    } finally {
      ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return rows;
}

/**
 * Signal-aware retrieval (0.3.4): a task that matches a decision domain triggers an
 * indexed, canonical-domain signal aggregation on top of normal preference retrieval.
 * Seeds N signals across 50 repos and measures warm retrieve() for a backend task, so
 * the number reflects the FULL added cost of automatic evidence surfacing at scale.
 */
function benchSignalRetrieval() {
  const DOMAINS: Record<string, string[]> = {
    backend: ["supabase", "firebase", "convex"],
    database: ["postgres", "sqlite", "mysql"],
    "package-manager": ["bun", "npm", "pnpm"],
    testing: ["vitest", "jest"],
    frontend: ["react", "vue", "svelte"],
  };
  const domainKeys = Object.keys(DOMAINS);
  const rows: Record<string, unknown>[] = [];
  for (const count of [1_000, 10_000, 50_000]) {
    const dir = mkdtempSync(join(tmpdir(), "bench-sig-"));
    const ctx = ctxFor(dir);
    try {
      withWriteTx(ctx.db, () => {
        for (let i = 0; i < count; i++) {
          const d = domainKeys[i % domainKeys.length]!;
          const cs = DOMAINS[d]!;
          ctx.signals.addInTx({ domain: d, choice: cs[i % cs.length]!, repoId: `r${i % 50}`, sessionId: `s${i}` });
        }
      });
      const q = { cwd: "/x", task: "set up the backend", track: false as const };
      const cold = time(() => void ctx.retrieval.retrieve(q));
      const iters = count >= 50_000 ? 40 : 150;
      const warm: number[] = [];
      let evidence = 0;
      for (let i = 0; i < iters; i++)
        warm.push(time(() => (evidence = ctx.retrieval.retrieve(q).observedPatterns?.length ?? 0)));
      rows.push({ signals: count, domainsSurfaced: evidence, coldMs: +cold.toFixed(3), warm: stat(warm), iters });
    } finally {
      ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return rows;
}

/**
 * Decision-aware remember (0.3.5): one atomic write that persists a preference AND a
 * decision signal. Measures per-op cost of plain `remember` vs `rememberWithDecision`
 * so the dual-write overhead (one extra SELECT+INSERT in the SAME transaction) is
 * visible. Both run in the same in-memory store on identical rule shapes.
 */
function benchDecisionRemember() {
  const dir = mkdtempSync(join(tmpdir(), "bench-dec-"));
  const ctx = ctxFor(dir);
  const N = 2_000;
  try {
    const plain: number[] = [];
    for (let i = 0; i < N; i++)
      plain.push(time(() => void ctx.preferences.remember({ rule: `Plain rule ${i} about topic ${i % 97}.`, scope: "global" })));
    const dual: number[] = [];
    for (let i = 0; i < N; i++)
      dual.push(
        time(() =>
          void ctx.rememberWithDecision(
            { rule: `Decision rule ${i} about topic ${i % 97}.`, scope: "global" },
            { domain: "backend", choice: `choice${i}`, repoId: `r${i % 20}` },
          ),
        ),
      );
    const p = stat(plain);
    const d = stat(dual);
    return { ops: N, plainRememberMs: p, decisionRememberMs: d, overheadMedianMs: +(d.median - p.median).toFixed(4) };
  } finally {
    ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function benchStartupLatency() {
  const dist = join(import.meta.dir, "..", "..", "dist", "index.js");
  if (!existsSync(dist)) return { skipped: "run `bun run build` first" };
  const node = whichSync("node");
  if (!node) return { skipped: "node not on PATH" };
  const home = mkdtempSync(join(tmpdir(), "bench-start-"));
  const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" };
  try {
    spawnSync(node, [dist, "init"], { env });
    spawnSync(node, [dist, "remember", "--scope", "global", "--category", "database", "Prefer foreign keys."], { env });
    const cmds: Record<string, string[]> = {
      version: ["--version"],
      prefs: ["prefs", "--json"],
      get: ["get", "--task", "database schema"],
      doctor: ["doctor", "--json", "--skip-adapter"],
      agents: ["agents", "--json"],
      hookCodex: ["hook", "codex-prompt"],
    };
    const out: Record<string, { median: number; p95: number }> = {};
    for (const [name, args] of Object.entries(cmds)) {
      const samples: number[] = [];
      for (let i = 0; i < 7; i++) {
        const input = name === "hookCodex" ? JSON.stringify({ cwd: home, prompt: "database schema" }) : undefined;
        samples.push(time(() => void spawnSync(node, [dist, ...args], { env, input, encoding: "utf8" })));
      }
      const s = stat(samples);
      out[name] = { median: s.median, p95: s.p95 };
    }
    return out;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function benchDbOpenCost() {
  const dir = mkdtempSync(join(tmpdir(), "bench-open-"));
  try {
    const paths = resolvePaths({ CTX_HOME: dir });
    // Prime the file (first open runs migrations under a lock).
    openDatabase(paths).close();
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) samples.push(time(() => openDatabase(paths).close()));
    return { reopenMs: stat(samples), note: "steady-state reopen of an already-migrated WAL db (no migration lock)" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function benchExportImport() {
  const srcDir = mkdtempSync(join(tmpdir(), "bench-exp-"));
  const dstDir = mkdtempSync(join(tmpdir(), "bench-imp-"));
  const src = ctxFor(srcDir);
  const dst = ctxFor(dstDir);
  try {
    bulkSeed(src.db, generateDataset(10_000, { seed: 2, repoCount: 30 }));
    let bundle: ReturnType<typeof exportData>;
    const exportMs = time(() => (bundle = exportData(src)));
    const importMs = time(() => importData(dst, bundle!));
    return { prefs: 10_000, exportMs: +exportMs.toFixed(1), importMs: +importMs.toFixed(1), bundlePrefs: bundle!.preferences.length };
  } finally {
    src.close();
    dst.close();
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(dstDir, { recursive: true, force: true });
  }
}

function benchDbSizeGrowth() {
  const dir = mkdtempSync(join(tmpdir(), "bench-size-"));
  try {
    const paths = resolvePaths({ CTX_HOME: dir });
    const db = openDatabase(paths);
    const N = 50_000;
    const ts = "2026-01-01T00:00:00.000Z";
    withWriteTx(db, () => {
      const ins = db.query(
        `INSERT INTO preferences (id, rule, normalized, category, domain, polarity, scope, repo_id, status, applicability, condition_json, confidence, version, created_at, updated_at, last_used_at, dedup_key)
         VALUES (?, ?, ?, 'general', NULL, 'neutral', 'global', NULL, 'approved', 'relevant', NULL, 1.0, 1, ?, ?, NULL, ?)`,
      );
      const ev = db.query(
        `INSERT INTO events (id, type, preference_id, repo_id, scope, summary, detail, agent_id, session_id, created_at) VALUES (?, 'preference.remembered', ?, NULL, 'global', ?, NULL, NULL, NULL, ?)`,
      );
      for (let i = 0; i < N; i++) {
        const id = newId();
        ins.run(id, `Rule number ${i} about topic ${i % 97}.`, `rule ${i}`, ts, ts, `global||rule ${i}|neutral|${i}`);
        ev.run(newId(), id, `Rule number ${i}`, ts);
      }
    });
    db.close();
    const full = statSync(paths.dbFile).size;
    // Delete everything, then measure (SQLite does NOT shrink the file without VACUUM).
    const db2 = openDatabase(paths);
    withWriteTx(db2, () => {
      db2.query("DELETE FROM preferences").run();
      db2.query("DELETE FROM events").run();
    });
    db2.close();
    const afterDelete = statSync(paths.dbFile).size;
    const db3 = openDatabase(paths);
    db3.exec("VACUUM");
    db3.close();
    const afterVacuum = statSync(paths.dbFile).size;
    return {
      rows: N,
      fullBytes: full,
      afterDeleteBytes: afterDelete,
      afterVacuumBytes: afterVacuum,
      note: "file stays large after DELETE (expected SQLite behavior); VACUUM reclaims it",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const result = {
  env: {
    platform: process.platform,
    node: process.version,
    bun: (globalThis as { Bun?: { version: string } }).Bun?.version ?? null,
    cwd: process.cwd(),
  },
  retrievalScaling: benchRetrievalScaling(),
  signalRetrieval: benchSignalRetrieval(),
  decisionRemember: benchDecisionRemember(),
  candidateReduction: benchCandidateReduction(),
  dbOpenCost: benchDbOpenCost(),
  exportImport: benchExportImport(),
  startupLatency: benchStartupLatency(),
  dbSizeGrowth: benchDbSizeGrowth(),
};

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  writeFileSync(process.argv[jsonFlag + 1]!, JSON.stringify(result, null, 2));
  console.log(`wrote ${process.argv[jsonFlag + 1]}`);
}
console.log(JSON.stringify(result, null, 2));
