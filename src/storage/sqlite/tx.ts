import type { Database } from "./driver.ts";

function isBusy(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    (typeof e?.code === "string" && e.code.includes("BUSY")) ||
    (typeof e?.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message))
  );
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` write transaction.
 *
 * IMMEDIATE acquires the write lock up front, so a SELECT-then-INSERT inside the
 * callback is atomic with respect to every other writer — this is what makes
 * concurrent `propose` dedup race-free. `busy_timeout` (set on the connection)
 * makes competing writers wait rather than fail; the extra retry loop here is a
 * belt-and-braces guard for the rare BUSY that slips past the timeout.
 */
export function withWriteTx<T>(db: Database, fn: () => T, maxRetries = 5): T {
  let attempt = 0;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      if (isBusy(err) && attempt < maxRetries) {
        attempt++;
        sleepSync(20 * attempt);
        continue;
      }
      throw err;
    }
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      if (isBusy(err) && attempt < maxRetries) {
        attempt++;
        sleepSync(20 * attempt);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Run `fn` inside a `BEGIN DEFERRED` read transaction so a multi-statement read
 * (e.g. `ctx get`) observes a single consistent snapshot: either fully before or
 * fully after any concurrent commit, never a half-applied state.
 */
export function withReadTx<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN DEFERRED");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}
