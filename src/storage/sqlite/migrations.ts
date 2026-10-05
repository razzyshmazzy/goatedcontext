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
  {
    version: 3,
    name: "events_audit_log",
    sql: `
      -- Append-only local audit log. Deliberately has NO foreign keys: an event
      -- (e.g. "forgotten") must survive the deletion of the preference/environment
      -- it refers to, so the history stays reconstructable. Secret VALUES are never
      -- written here — only rule text, names, and safe metadata.
      CREATE TABLE events (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        preference_id  TEXT,
        repo_id        TEXT,
        scope          TEXT,
        summary        TEXT NOT NULL,
        detail         TEXT,
        agent_id       TEXT,
        session_id     TEXT,
        created_at     TEXT NOT NULL
      );

      CREATE INDEX idx_events_created ON events(created_at);
      CREATE INDEX idx_events_repo ON events(repo_id);
      CREATE INDEX idx_events_pref ON events(preference_id);
    `,
  },
  {
    version: 4,
    name: "preference_applicability",
    sql: `
      -- Applicability decides HOW a preference is retrieved:
      --   'relevant' — injected only when relevant to the task (the prior behavior)
      --   'always'   — injected on every prompt, bypassing relevance scoring
      -- Stored as free TEXT (validated in the app layer) so a future release can add
      -- 'conditional' without a destructive migration. Existing rows default to
      -- 'relevant', preserving current behavior exactly.
      ALTER TABLE preferences ADD COLUMN applicability TEXT NOT NULL DEFAULT 'relevant';
    `,
  },
  {
    version: 5,
    name: "preference_condition",
    sql: `
      -- Conditional preferences (0.2.8) carry a structured, serialized condition
      -- that is evaluated deterministically against a normalized RuntimeContext.
      -- Stored as canonical JSON TEXT, NULL for 'relevant'/'always' rows. This is a
      -- purely additive migration: every existing row keeps condition_json = NULL,
      -- so 'relevant' and 'always' behavior is byte-for-byte unchanged. The enum
      -- extension ('relevant' | 'always' | 'conditional') needs no schema change
      -- because applicability is free TEXT validated in the app layer.
      --
      -- Invariants (enforced in the app layer, see conditions.ts):
      --   relevant    => condition_json IS NULL
      --   always      => condition_json IS NULL
      --   conditional => condition_json IS a valid condition
      ALTER TABLE preferences ADD COLUMN condition_json TEXT;
    `,
  },
  {
    version: 6,
    name: "dedup_key_general_index",
    sql: `
      -- A GENERAL (non-unique) index on dedup_key. The v2 index
      -- (idx_prefs_dedup_unique) is PARTIAL — it only covers proposed/observed rows,
      -- because it enforces the at-most-one-pending-proposal-per-key constraint. As a
      -- result, a dedup_key lookup over approved/locked rows (every ctx import
      -- record does one) fell back to a full table scan, making a large import
      -- O(n^2). This additive, non-unique index turns that lookup into an index seek
      -- with no behavior change (indexes never alter results). Kept ALONGSIDE the
      -- partial unique index, which still enforces the proposal-dedup constraint.
      CREATE INDEX IF NOT EXISTS idx_prefs_dedup ON preferences(dedup_key);
    `,
  },
  {
    version: 7,
    name: "decision_signals",
    sql: `
      -- Non-authoritative EVIDENCE of developer decisions (0.3.2). A signal records a
      -- meaningful development CHOICE at the moment it happens (domain=backend,
      -- choice=supabase) so the agent can later reason about recurring patterns across
      -- repos/sessions and, by its own judgment, PROPOSE a preference. Signals are NOT
      -- preferences: they never directly instruct the agent and are never injected as
      -- authoritative context. No transcripts, no source code, no secrets — only the
      -- compact (domain, choice) decision plus provenance. Deliberately has NO foreign
      -- key to repos (mirrors the events log): a signal is durable cross-repo evidence
      -- that must survive a repo row being removed, keeping distinct-repo counts honest.
      CREATE TABLE decision_signals (
        id          TEXT PRIMARY KEY,
        domain      TEXT NOT NULL,   -- normalized decision domain, e.g. 'backend'
        choice      TEXT NOT NULL,   -- normalized choice, e.g. 'supabase'
        choice_raw  TEXT NOT NULL,   -- the choice as originally given (for display)
        repo_id     TEXT,            -- local repo id where the decision happened (nullable)
        session_id  TEXT,            -- host session id when available (nullable)
        agent_id    TEXT,            -- which agent recorded it (nullable)
        context     TEXT,            -- optional short provenance note (capped; never secrets)
        created_at  TEXT NOT NULL
      );

      CREATE INDEX idx_signals_domain ON decision_signals(domain);
      CREATE INDEX idx_signals_domain_choice ON decision_signals(domain, choice);
      CREATE INDEX idx_signals_repo ON decision_signals(repo_id);
      CREATE INDEX idx_signals_created ON decision_signals(created_at);
    `,
  },
];
