import type { Database } from "bun:sqlite";
import { resolvePaths, type CtxPaths } from "../storage/paths.ts";
import { loadConfig, ensureHome, type Config } from "../storage/config.ts";
import { openDatabase } from "../storage/sqlite/db.ts";
import { createSecretStore, type SecretStore } from "../storage/secrets/index.ts";
import { PreferenceService } from "./preferences/service.ts";
import { RepoService } from "./repos/repo.ts";
import { EnvironmentService } from "./environments/service.ts";
import { RetrievalEngine } from "./retrieval/retrieval.ts";

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
  readonly retrieval: RetrievalEngine;

  private constructor(paths: CtxPaths, config: Config, db: Database, secrets: SecretStore) {
    this.paths = paths;
    this.config = config;
    this.db = db;
    this.secrets = secrets;
    this.preferences = new PreferenceService(db);
    this.repos = new RepoService(db);
    this.environments = new EnvironmentService(db, secrets);
    this.retrieval = new RetrievalEngine(
      db,
      this.preferences,
      this.repos,
      this.environments,
    );
  }

  static open(env: NodeJS.ProcessEnv = process.env): CtxContext {
    const paths = resolvePaths(env);
    ensureHome(paths);
    const db = openDatabase(paths);
    const config = loadConfig(paths);
    const secrets = createSecretStore(paths, env);
    return new CtxContext(paths, config, db, secrets);
  }

  /** Build a context around an already-open database (used by tests). */
  static fromParts(paths: CtxPaths, config: Config, db: Database, secrets: SecretStore): CtxContext {
    return new CtxContext(paths, config, db, secrets);
  }

  close(): void {
    this.db.close();
  }
}
