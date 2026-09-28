/**
 * SQLite driver abstraction.
 *
 * ctx is developed and tested with Bun (`bun:sqlite`) but is published as a normal
 * npm package that must run on Node without Bun. The two runtimes ship different
 * SQLite bindings, so this module hides that behind one tiny synchronous interface
 * and picks the right backend when a database is opened:
 *
 *   - under Bun  → `bun:sqlite`      (development + `bun test`)
 *   - under Node → `better-sqlite3`  (the published CLI users install)
 *
 * Both are loaded with `createRequire` so neither is a static import: the Node
 * bundle never references `bun:sqlite`, and Bun never tries to dlopen the
 * `better-sqlite3` native addon (which it cannot load). Loading is synchronous,
 * so the rest of the storage layer stays synchronous exactly as before.
 *
 * The interface is deliberately the minimal subset the codebase actually uses —
 * `exec`, `query().{get,all,run}`, `close` — which is what makes one shared type
 * safe across two different bindings.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/** Result of a mutating statement. Both bindings return this shape from `run`. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement<Row = unknown, Params extends unknown[] = unknown[]> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
  run(...params: Params): RunResult;
}

export interface Database {
  exec(sql: string): void;
  query<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): Statement<Row, Params>;
  close(): void;
}

export interface OpenOptions {
  /** Open read-only (used by `ctx doctor`'s non-mutating integrity check). */
  readonly?: boolean;
  /** Create the file if it does not exist. Defaults to true unless read-only. */
  create?: boolean;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Coerce bind parameters to the value types SQLite accepts, matching bun:sqlite's
 * lenient behavior so the Node (`better-sqlite3`) path behaves identically:
 * booleans → 0/1 and `undefined` → null. better-sqlite3 otherwise throws on those.
 * Everything else passes through untouched (and the common case allocates nothing).
 */
function normalizeParams(params: unknown[]): unknown[] {
  let needsCopy = false;
  for (const p of params) {
    if (typeof p === "boolean" || p === undefined) {
      needsCopy = true;
      break;
    }
  }
  if (!needsCopy) return params;
  return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function wrapBun(raw: any): Database {
  return {
    exec: (sql: string) => raw.exec(sql),
    query<Row, P extends unknown[]>(sql: string): Statement<Row, P> {
      const st = raw.query(sql);
      return {
        get: (...params: unknown[]) => (st.get(...params) ?? null),
        all: (...params: unknown[]) => st.all(...params),
        run: (...params: unknown[]) => st.run(...params) as RunResult,
      } as Statement<Row, P>;
    },
    close: () => raw.close(),
  };
}

function wrapBetter(raw: any): Database {
  return {
    exec: (sql: string) => raw.exec(sql),
    query<Row, P extends unknown[]>(sql: string): Statement<Row, P> {
      const st = raw.prepare(sql);
      return {
        get: (...params: unknown[]) => (st.get(...normalizeParams(params)) ?? null),
        all: (...params: unknown[]) => st.all(...normalizeParams(params)),
        run: (...params: unknown[]) => st.run(...normalizeParams(params)) as RunResult,
      } as Statement<Row, P>;
    },
    close: () => raw.close(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Open a SQLite database using whichever binding the current runtime supports.
 * The returned handle exposes the same small surface regardless of backend.
 */
export function openDb(path: string, opts: OpenOptions = {}): Database {
  if (isBun) {
    const { Database: BunDatabase } = nodeRequire("bun:sqlite");
    const raw = new BunDatabase(path, {
      readonly: opts.readonly ?? false,
      create: opts.create ?? !opts.readonly,
    });
    return wrapBun(raw);
  }
  const BetterDatabase = nodeRequire("better-sqlite3");
  const raw = new BetterDatabase(path, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.readonly ?? false,
  });
  return wrapBetter(raw);
}

/** Which SQLite backend this runtime uses, for diagnostics (`ctx doctor`). */
export function sqliteBackend(): "bun:sqlite" | "better-sqlite3" {
  return isBun ? "bun:sqlite" : "better-sqlite3";
}
