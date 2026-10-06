// Test-only helper (NOT shipped): open the ctx database, acquire a write lock with
// BEGIN IMMEDIATE, announce "LOCKED" on stdout, hold it for a controlled duration, then
// COMMIT and exit. Used by the deterministic forced-lock contention test (spec §19).
//
//   CTX_HOME=<dir> bun run tests/support/lock-holder.ts <holdMs>
import { writeFileSync } from "node:fs";
import { openDatabase } from "../../src/storage/sqlite/db.ts";
import { resolvePaths } from "../../src/storage/paths.ts";

const home = process.env.CTX_HOME;
if (!home) {
  process.stderr.write("lock-holder: CTX_HOME is required\n");
  process.exit(2);
}
const holdMs = Number.parseInt(process.argv[2] ?? "500", 10);

const db = openDatabase(resolvePaths({ CTX_HOME: home }));
db.exec("BEGIN IMMEDIATE");
// Signal that the write lock is held so the contender starts from a known state.
process.stdout.write("LOCKED\n");
const readyFile = process.env.CTX_LOCK_READY_FILE;
if (readyFile) writeFileSync(readyFile, "LOCKED");
// Hold the lock synchronously (blocks this process; that is the point).
Bun.sleepSync(holdMs);
db.exec("COMMIT");
db.close();
process.stdout.write("RELEASED\n");
