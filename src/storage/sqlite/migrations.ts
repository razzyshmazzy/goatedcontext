/**
 * Ordered schema migrations. Each migration runs exactly once, tracked in the
 * `schema_migrations` table. Never edit a shipped migration — add a new one.
 *
 * Design notes for future scope:
 *  - `preferences.scope` is a free TEXT column (validated in the app layer), so a
 *    new scope such as `org` can be introduced without a schema change; only a
 *    nullable `org_id` column would need to be added in a later migration.
 *  - Secret VALUES are never stored here. `environment_variables` only records
 *    variable names plus an opaque `secret_ref` pointing at the secret store.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE repos (
        id            TEXT PRIMARY KEY,
        identity      TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        remote_url    TEXT,
        root_path     TEXT NOT NULL,
        has_remote    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE preferences (
        id             TEXT PRIMARY KEY,
        rule           TEXT NOT NULL,
        normalized     TEXT NOT NULL,
        category       TEXT NOT NULL,
        scope          TEXT NOT NULL,
        repo_id        TEXT,
        status         TEXT NOT NULL,
        confidence     REAL NOT NULL DEFAULT 0.5,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        last_used_at   TEXT,
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_prefs_scope ON preferences(scope);
      CREATE INDEX idx_prefs_repo ON preferences(repo_id);
      CREATE INDEX idx_prefs_status ON preferences(status);

      CREATE TABLE evidence (
        id             TEXT PRIMARY KEY,
        preference_id  TEXT NOT NULL,
        source         TEXT NOT NULL,
        repo_id        TEXT,
        evidence_text  TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        FOREIGN KEY (preference_id) REFERENCES preferences(id) ON DELETE CASCADE,
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_evidence_pref ON evidence(preference_id);

      CREATE TABLE environments (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        scope          TEXT NOT NULL,
        repo_id        TEXT,
        risk_level     TEXT NOT NULL DEFAULT 'test',
        description    TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
        UNIQUE (name, scope, repo_id)
      );

      CREATE TABLE environment_variables (
        id             TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        var_name       TEXT NOT NULL,
        secret_ref     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
        UNIQUE (environment_id, var_name)
      );
    `,
  },
  {
    version: 2,
    name: "domains_polarity_versioning_provenance",
    sql: `
      -- Conflict/dedup metadata for preferences.
      ALTER TABLE preferences ADD COLUMN domain TEXT;
      ALTER TABLE preferences ADD COLUMN polarity TEXT NOT NULL DEFAULT 'neutral';
      -- Optimistic-concurrency version; bumped on every state change.
      ALTER TABLE preferences ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      -- Canonical (scope|repo|subject|polarity) key for race-free proposal dedup.
      ALTER TABLE preferences ADD COLUMN dedup_key TEXT;

      CREATE INDEX idx_prefs_domain ON preferences(domain);

      -- At most one proposed/observed preference per dedup_key: a hard, atomic
      -- backstop against concurrent duplicate proposals. NULL keys (legacy rows)
      -- are distinct in SQLite, so old data is unaffected.
      CREATE UNIQUE INDEX idx_prefs_dedup_unique
        ON preferences(dedup_key)
        WHERE dedup_key IS NOT NULL AND status IN ('proposed','observed');

      -- Lightweight provenance + evidence dedup.
      ALTER TABLE evidence ADD COLUMN agent_id TEXT;
      ALTER TABLE evidence ADD COLUMN session_id TEXT;
      ALTER TABLE evidence ADD COLUMN text_hash TEXT;

      -- Exact-duplicate evidence per preference is collapsed atomically.
      CREATE UNIQUE INDEX idx_evidence_dedup
        ON evidence(preference_id, text_hash)
        WHERE text_hash IS NOT NULL;
    `,
  },
];
