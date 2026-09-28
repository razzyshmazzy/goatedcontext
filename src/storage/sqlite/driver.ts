/**
 * SQLite driver abstraction.
 *
 * ctx is developed and tested with Bun (`bun:sqlite`) but is published as a normal
 * npm package that must run on Node. Both runtimes ship a *built-in*, synchronous
 * SQLite binding, so this module hides the difference behind one tiny interface and
 * picks the right backend when a database is opened:
 *
 *   - under Bun  → `bun:sqlite`   (development + `bun test`)
 *   - under Node → `node:sqlite`  (the published CLI users install)
 *
 * Neither backend is a native addon: `node:sqlite` is part of Node itself, so the
 * published package has ZERO native dependencies — no `node-gyp`, no prebuilt
 * binary download, no C++/Python toolchain. Both are loaded with `createRequire`
 * so neither is a static import: the Node bundle never references `bun:sqlite`, and
 * Bun never touches `node:sqlite`. Loading is synchronous, so the rest of the
 * storage layer stays synchronous exactly as before.
 *
 * The interface is deliberately the minimal subset the codebase actually uses —
 * `exec`, `query().{get,all,run}`, `close` — which is what makes one shared type
 * safe across two different bindings. Any behavioral difference between the two
 * (parameter coercion, missing-row result, run() metadata) is normalized HERE so
 * core services never see a runtime-specific quirk.
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
 * Coerce bind parameters to the value types SQLite accepts, so both bindings
 * behave identically: booleans → 0/1 and `undefined` → null. Neither `bun:sqlite`
 * (lenient) nor `node:sqlite` (strict — it throws on booleans and `undefined`)
 * requires callers to do this, so we do it once, centrally. Everything else passes
 * through untouched (and the common case allocates nothing).
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
        get: (...params: unknown[]) => (st.get(...normalizeParams(params)) ?? null),
        all: (...params: unknown[]) => st.all(...normalizeParams(params)),
        run: (...params: unknown[]) => st.run(...normalizeParams(params)) as RunResult,
      } as Statement<Row, P>;
    },
    close: () => raw.close(),
  };
}

/**
 * `node:sqlite` (Node ≥ 22.13 / ≥ 23.4) exposes `DatabaseSync` with a
 * `StatementSync` API very close to `bun:sqlite`. Differences we
 * normalize here:
 *   - `get()` returns `undefined` (not null) for no row → coerce to null.
 *   - strict binding: booleans and `undefined` throw → `normalizeParams`.
 *   - `run()` already returns `{ changes, lastInsertRowid }`.
 * A prepared statement is re-created per `query()` call, matching the other
 * backends' usage in this codebase (statements are short-lived, not cached).
 */
function wrapNode(raw: any): Database {
  return {
    exec: (sql: string) => raw.exec(sql),
    query<Row, P extends unknown[]>(sql: string): Statement<Row, P> {
      const st = raw.prepare(sql);
      return {
        get: (...params: unknown[]) => (st.get(...normalizeParams(params)) ?? null),
        all: (...params: unknown[]) => st.all(...normalizeParams(params)),
        run: (...params: unknown[]) => {
          const r = st.run(...normalizeParams(params));
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid } as RunResult;
        },
      } as Statement<Row, P>;
    },
    close: () => raw.close(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * `node:sqlite` is a built-in but still marked experimental, so the first
 * `require("node:sqlite")` prints an `ExperimentalWarning` to stderr. That noise
 * would leak into every `ctx` invocation (and into the prompt hook's output
 * channel). Suppress ONLY that specific warning by intercepting `emitWarning`
 * before the first require; all other warnings pass through untouched. Installed
 * once, lazily, and only on the Node path.
 */
let warningFilterInstalled = false;
function suppressSqliteExperimentalWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const opt = args[0];
    const type =
      typeof opt === "string" ? opt : opt && typeof opt === "object" ? (opt as { type?: string }).type : undefined;
    const text = typeof warning === "string" ? warning : (warning as Error)?.message ?? "";
    if (String(type) === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

/**
 * Open a SQLite database using whichever built-in binding the current runtime
 * supports. The returned handle exposes the same small surface regardless of
 * backend.
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
  suppressSqliteExperimentalWarning();
  const { DatabaseSync } = nodeRequire("node:sqlite");
  // node:sqlite opens read-write and creates the file by default; a read-only
  // open requires the file to already exist (matching the previous
  // `fileMustExist` behavior used by the doctor's integrity check).
  const raw = new DatabaseSync(path, { readOnly: opts.readonly ?? false });
  return wrapNode(raw);
}

/** Which SQLite backend this runtime uses, for diagnostics (`ctx doctor`). */
export function sqliteBackend(): "bun:sqlite" | "node:sqlite" {
  return isBun ? "bun:sqlite" : "node:sqlite";
}
