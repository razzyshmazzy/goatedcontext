import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, withFileLock } from "../../utils/fs.ts";
import { nowIso } from "../../utils/time.ts";

/**
 * Local-only effectiveness stats.
 *
 * goatedcontext is intentionally invisible when it works, so these aggregate
 * counters let a user see how often context is actually being injected — without
 * any remote telemetry and without any per-event detail that could leak content.
 *
 * PRIVACY INVARIANT: this store holds ONLY counters and a single timestamp. It
 * never contains prompt text, preference text, repo names/paths, secret values,
 * environment-variable names, session ids or agent ids. See `sanitize()` — every
 * field is coerced to a non-negative integer (or a plain ISO string) so a corrupt
 * or hand-edited file can never smuggle other data into the process.
 *
 * STORAGE: a small dedicated `stats.json` under CTX_HOME, completely separate from
 * the SQLite preference database. The prompt hook therefore stays read-only with
 * respect to the main DB; recording a hook run only ever touches this file.
 *
 * CONCURRENCY: many Claude agents run concurrently, so updates must not lose
 * increments. Each mutation takes a short-lived cross-process advisory lock
 * (`withFileLock`), re-reads the file inside the lock, increments, and writes it
 * back atomically (`writeFileAtomic`). No naive unlocked read-modify-write, and no
 * long-lived lock.
 *
 * FAIL-OPEN: recording must never break Claude. Every mutation is wrapped so any
 * error (lock timeout, unwritable store, corrupt file) is swallowed and reported
 * only via the boolean return; reads recover to a clean zero-state.
 */
export interface Stats {
  /** Every time the Claude prompt hook executes and completes retrieval. */
  hookRuns: number;
  /** Hook runs where at least one relevant preference was actually injected. */
  contextInjections: number;
  /** Hook runs that injected nothing because nothing relevant matched. */
  noMatch: number;
  /** Total number of preferences included across all injections. */
  preferencesInjected: number;
  /** New proposals created via `ctx propose` (merges into an existing proposal do not count). */
  proposalsCreated: number;
  /** ISO timestamp of the most recent successful injection, or null if none yet. */
  lastInjectionAt: string | null;
}

/** Stable, machine-readable snake_case shape used for the on-disk file and `--json`. */
export interface StatsJson {
  hook_runs: number;
  context_injections: number;
  no_match: number;
  preferences_injected: number;
  proposals_created: number;
  last_injection_at: string | null;
}

const STORE_VERSION = 1;

export function zeroStats(): Stats {
  return {
    hookRuns: 0,
    contextInjections: 0,
    noMatch: 0,
    preferencesInjected: 0,
    proposalsCreated: 0,
    lastInjectionAt: null,
  };
}

/** Coerce one field to a finite, non-negative integer; anything else → 0. */
function counter(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Turn arbitrary parsed JSON into a valid Stats, discarding anything unexpected.
 * This is both the corruption-recovery path and the privacy gate: only known
 * counters and a plain ISO timestamp survive.
 */
function sanitize(raw: unknown): Stats {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const last = o.last_injection_at;
  return {
    hookRuns: counter(o.hook_runs),
    contextInjections: counter(o.context_injections),
    noMatch: counter(o.no_match),
    preferencesInjected: counter(o.preferences_injected),
    proposalsCreated: counter(o.proposals_created),
    lastInjectionAt: typeof last === "string" && last.length > 0 ? last : null,
  };
}

export function toJson(s: Stats): StatsJson {
  return {
    hook_runs: s.hookRuns,
    context_injections: s.contextInjections,
    no_match: s.noMatch,
    preferences_injected: s.preferencesInjected,
    proposals_created: s.proposalsCreated,
    last_injection_at: s.lastInjectionAt,
  };
}

function serialize(s: Stats): string {
  return JSON.stringify({ version: STORE_VERSION, ...toJson(s) }, null, 2) + "\n";
}

export class StatsStore {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(home: string) {
    this.file = join(home, "stats.json");
    this.lockFile = this.file + ".lock";
  }

  /** Absolute path of the stats file (for diagnostics). */
  get path(): string {
    return this.file;
  }

  /**
   * Read the current stats. Never throws: a missing store returns a clean
   * zero-state, and a malformed/corrupt store is treated as zero rather than
   * propagating a parse error into `ctx stats` (or the hook).
   */
  read(): Stats {
    try {
      if (!existsSync(this.file)) return zeroStats();
      return sanitize(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return zeroStats();
    }
  }

  /**
   * Apply `mutate` to the stats under a short-lived exclusive lock, re-reading
   * inside the lock so concurrent writers can never lose an increment. The write
   * itself is atomic. Fail-open: returns false (never throws) if the update could
   * not be persisted for any reason.
   */
  private update(mutate: (s: Stats) => void): boolean {
    try {
      withFileLock(
        this.lockFile,
        () => {
          const current = this.read();
          mutate(current);
          writeFileAtomic(this.file, serialize(current), 0o600);
        },
        { timeoutMs: 5000 },
      );
      return true;
    } catch {
      return false; // fail-open: stats must never break the caller
    }
  }

  /**
   * Record a hook run that injected at least one preference. Increments hook_runs
   * and context_injections, adds the injected count, and stamps last_injection_at.
   */
  recordHookInjection(preferenceCount: number): boolean {
    const n = counter(preferenceCount);
    return this.update((s) => {
      s.hookRuns += 1;
      s.contextInjections += 1;
      s.preferencesInjected += n;
      s.lastInjectionAt = nowIso();
    });
  }

  /** Record a hook run that matched nothing. Increments hook_runs and no_match. */
  recordHookNoMatch(): boolean {
    return this.update((s) => {
      s.hookRuns += 1;
      s.noMatch += 1;
    });
  }

  /** Record that `ctx propose` created a brand-new proposal (not an evidence merge). */
  recordProposalCreated(): boolean {
    return this.update((s) => {
      s.proposalsCreated += 1;
    });
  }

  /** Clear only the stats counters. Never touches preferences/environments/history. */
  reset(): boolean {
    return this.update((s) => {
      const z = zeroStats();
      s.hookRuns = z.hookRuns;
      s.contextInjections = z.contextInjections;
      s.noMatch = z.noMatch;
      s.preferencesInjected = z.preferencesInjected;
      s.proposalsCreated = z.proposalsCreated;
      s.lastInjectionAt = z.lastInjectionAt;
    });
  }
}
