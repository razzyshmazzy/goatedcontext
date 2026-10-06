#!/usr/bin/env bun
/**
 * Release STRESS suite (spec §18 / amendment 4). This is intentionally NOT part of the
 * routine `bun test` run — it is a heavier, timing-sensitive multiprocess torture test
 * meant to be run before a release. CI stays deterministic; this gives release
 * confidence.
 *
 *   bun run stress
 *
 * Concurrently, across several rounds, against ONE shared SQLite store:
 *   - 32 reader processes            (ctx agent context)
 *   -  4 context-retrieval processes (ctx get)
 *   -  8 signal-writer processes     (ctx agent signal add — distinct choices)
 *   -  4 remember/propose writers    (ctx agent remember / propose — distinct rules)
 *
 * Asserts: zero uncaught "database is locked", zero nonzero exits, zero LOST committed
 * writes (every distinct write is present afterward), and a clean PRAGMA integrity_check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";
import { SignalService } from "../src/core/signals/service.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dirname, "..", "src", "index.ts");
const ROUNDS = Number.parseInt(process.env.STRESS_ROUNDS ?? "3", 10);

const home = mkdtempSync(join(tmpdir(), "ctx-stress-"));
const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" } as Record<string, string>;

interface Res { kind: string; code: number; err: string }

function spawn(kind: string, args: string[]): Promise<Res> {
  const p = Bun.spawn([BUN, "run", INDEX, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return (async () => {
    const err = await new Response(p.stderr).text();
    await new Response(p.stdout).text();
    return { kind, code: await p.exited, err };
  })();
}

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

const started = performance.now();

// Initialize the schema up front (so round 1 is pure contention, not migration).
await spawn("init", ["domains", "--json"]);

let lockErrors = 0;
let failures = 0;
const expectedSignals = new Set<string>();
const expectedRules = new Set<string>();

for (let round = 0; round < ROUNDS; round++) {
  const jobs: Promise<Res>[] = [];
  for (let i = 0; i < 32; i++) {
    jobs.push(spawn("read", ["agent", "context", "--task", "set up the backend database", "--json"]));
  }
  for (let i = 0; i < 4; i++) {
    jobs.push(spawn("retrieve", ["get", "--task", "pick a database"]));
  }
  for (let i = 0; i < 8; i++) {
    const choice = `stress-r${round}-w${i}`;
    expectedSignals.add(choice);
    jobs.push(spawn("signal", ["agent", "signal", "add", "--origin", "user", "--domain", "database", "--choice", choice, "--no-repo"]));
  }
  for (let i = 0; i < 4; i++) {
    const rule = `Stress preference r${round} w${i}.`;
    expectedRules.add(rule);
    jobs.push(spawn("write", ["agent", "remember", rule, "--origin", "user", "--scope", "global"]));
  }
  const results = await Promise.all(jobs);
  for (const r of results) {
    if (/database is locked|SQLITE_BUSY/i.test(r.err)) {
      lockErrors++;
      log(`  [${r.kind}] LOCK ERROR: ${r.err.split("\n")[0]}`);
    }
    if (r.code !== 0) {
      failures++;
      log(`  [${r.kind}] exit ${r.code}: ${r.err.split("\n")[0]}`);
    }
  }
  log(`round ${round + 1}/${ROUNDS}: ${results.length} processes done`);
}

// ---- verification (in-process, after every child committed) -----------------
const db = openDatabase(resolvePaths({ CTX_HOME: home }));
const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
const integrityOk = integrity?.integrity_check?.toLowerCase() === "ok";

const signals = new SignalService(db);
const prefs = new PreferenceService(db);
const seenSignals = new Set(signals.list().map((s) => s.choiceRaw));
const seenRules = new Set(prefs.list().map((p) => p.rule));
db.close();

const lostSignals = [...expectedSignals].filter((c) => !seenSignals.has(c));
const lostRules = [...expectedRules].filter((r) => !seenRules.has(r));
const elapsed = Math.round(performance.now() - started);

log("");
log("=== goatedcontext stress report ===");
log(`rounds:              ${ROUNDS}`);
log(`processes/round:     48 (32 read + 4 retrieve + 8 signal + 4 write)`);
log(`elapsed:             ${elapsed}ms`);
log(`uncaught lock errors:${lockErrors}`);
log(`nonzero exits:       ${failures}`);
log(`expected signals:    ${expectedSignals.size}  lost: ${lostSignals.length}`);
log(`expected rules:      ${expectedRules.size}  lost: ${lostRules.length}`);
log(`integrity_check:     ${integrity?.integrity_check ?? "(unknown)"}`);

rmSync(home, { recursive: true, force: true });

const ok =
  lockErrors === 0 && failures === 0 && lostSignals.length === 0 && lostRules.length === 0 && integrityOk;
log("");
log(ok ? "STRESS PASS" : "STRESS FAIL");
process.exit(ok ? 0 : 1);
