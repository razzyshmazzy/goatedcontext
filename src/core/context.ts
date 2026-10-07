import { join } from "node:path";
import type { Database } from "../storage/sqlite/driver.ts";
import { resolvePaths, type CtxPaths } from "../storage/paths.ts";
import { loadConfig, ensureHome, type Config } from "../storage/config.ts";
import { openDatabase } from "../storage/sqlite/db.ts";
import { createSecretStore, type SecretStore } from "../storage/secrets/index.ts";
import { PreferenceService, type RememberInput } from "./preferences/service.ts";
import { RepoService } from "./repos/repo.ts";
import { EnvironmentService } from "./environments/service.ts";
import { EventService } from "./events/service.ts";
import { SignalService, type Signal } from "./signals/service.ts";
import { RetrievalEngine } from "./retrieval/retrieval.ts";
import { StatsStore } from "./stats/stats.ts";
import type { Preference } from "./preferences/types.ts";
import { withWriteTx } from "../storage/sqlite/tx.ts";

/**
 * The optional decision-evidence half of a decision-aware `remember`. When present,
 * a single `rememberWithDecision` call persists BOTH the authoritative preference and
 * this non-authoritative signal in ONE transaction. Mirrors the signal `add` fields.
 */
export interface DecisionInput {
  domain: string;
  choice: string;
  preferredChoice?: string | null;
  reason?: string | null;
  constraint?: string | null;
  exception?: boolean;
  repoId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  context?: string | null;
  /** Source class of the decision (0.3.7). Defaults to the preference's own origin. */
  origin?: string;
}

export interface RememberWithDecisionResult {
  preference: Preference;
  /** The recorded (or deduped) decision signal, or null when no decision was supplied. */
  signal: Signal | null;
  /** Whether a NEW signal row was created (false = deduped existing or no decision). */
  signalCreated: boolean;
}

/**
 * The composition root for the ctx engine. Owns the database, config, secret
 * store and the domain services. Both the CLI and any future adapter (MCP,
 * Codex, Cursor) build one of these and talk to the services — never to storage
 * directly.
 */
export class CtxContext {
  readonly paths: CtxPaths;
  readonly config: Config;
  readonly db: Database;
  readonly secrets: SecretStore;
  readonly preferences: PreferenceService;
  readonly repos: RepoService;
  readonly environments: EnvironmentService;
  readonly events: EventService;
  /** Non-authoritative ledger of developer decisions (evidence, never instructions). */
  readonly signals: SignalService;
  readonly retrieval: RetrievalEngine;
  /** Local-only aggregate effectiveness stats (a plain JSON file, never in SQLite). */
  readonly stats: StatsStore;

  private constructor(paths: CtxPaths, config: Config, db: Database, secrets: SecretStore) {
    this.paths = paths;
    this.config = config;
    this.db = db;
    this.secrets = secrets;
    this.preferences = new PreferenceService(db);
    this.repos = new RepoService(db);
    this.environments = new EnvironmentService(db, secrets, join(paths.home, "env-write.lock"));
    this.events = new EventService(db);
    this.signals = new SignalService(db);
    this.stats = new StatsStore(paths.home);
    this.retrieval = new RetrievalEngine(
      db,
      this.preferences,
      this.repos,
      this.environments,
      this.signals,
    );
  }

  /**
   * Open a context. `opts.busyTimeoutMs` bounds the DB lock-wait for THIS context only
   * (the prompt hook passes a short value so a locked DB fails open fast instead of
   * stalling the agent); normal callers omit it and keep the durable default.
   */
  static open(
    env: NodeJS.ProcessEnv = process.env,
    opts: { busyTimeoutMs?: number } = {},
  ): CtxContext {
    const paths = resolvePaths(env);
    ensureHome(paths);
    const db = openDatabase(paths, { busyTimeoutMs: opts.busyTimeoutMs });
    // A throw AFTER the DB is open but BEFORE the context is constructed (a corrupt
    // config.json, or CTX_SECRET_BACKEND=dpapi on a machine without DPAPI) would leak
    // the open SQLite handle + its -wal/-shm files, since the caller's `finally`
    // never runs. Close it on failure and rethrow the original error.
    try {
      const config = loadConfig(paths);
      const secrets = createSecretStore(paths, env);
      return new CtxContext(paths, config, db, secrets);
    } catch (err) {
      try {
        db.close();
      } catch {
        /* already closing down due to err — ignore */
      }
      throw err;
    }
  }

  /** Build a context around an already-open database (used by tests). */
  static fromParts(paths: CtxPaths, config: Config, db: Database, secrets: SecretStore): CtxContext {
    return new CtxContext(paths, config, db, secrets);
  }

  /**
   * DECISION-AWARE write (0.3.5): persist an authoritative preference and, optionally,
   * a non-authoritative decision signal in ONE transaction. A meaningful
   * architecture/tooling choice ("Use Supabase for the backend") is BOTH a repo
   * convention (preference) AND cross-repo evidence (signal) — recording both in a
   * single atomic write avoids a half-written pair and a second approval round-trip.
   *
   * Atomicity: the preference is written first; if it throws, no signal is attempted.
   * If the signal write throws, the whole transaction rolls back, so a failed signal
   * never leaves a committed preference behind (and vice versa). Signal dedup is
   * unchanged — the same decision in the same immediate context does not spam rows.
   */
  rememberWithDecision(
    prefInput: RememberInput,
    decision?: DecisionInput | null,
  ): RememberWithDecisionResult {
    return withWriteTx(this.db, () => {
      const preference = this.preferences.rememberInTx(prefInput);
      if (!decision) return { preference, signal: null, signalCreated: false };
      const { signal, created } = this.signals.addInTx({
        domain: decision.domain,
        choice: decision.choice,
        repoId: decision.repoId ?? prefInput.repoId ?? null,
        sessionId: decision.sessionId ?? prefInput.sessionId ?? null,
        agentId: decision.agentId ?? prefInput.agentId ?? null,
        context: decision.context ?? null,
        preferredChoice: decision.preferredChoice ?? null,
        reason: decision.reason ?? null,
        constraint: decision.constraint ?? null,
        exception: decision.exception ?? false,
        // The decision shares the preference's provenance unless overridden. Since the
        // preference guard already ran above, a non-user origin never reaches here.
        origin: decision.origin ?? prefInput.origin,
      });
      return { preference, signal, signalCreated: created };
    });
  }

  close(): void {
    this.db.close();
  }
}
