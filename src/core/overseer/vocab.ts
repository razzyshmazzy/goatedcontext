/**
 * The OVERSEER activation vocabulary (prototype).
 *
 * This is the small, constrained, CLOSED vocabulary the event-driven activation
 * layer speaks. It is deliberately NOT a programming language and NOT an ontology:
 * every term is a literal string matched by set-membership or glob. The domains
 * reuse the existing canonical decision-domain vocabulary (`signals/domains.ts`) so
 * the overseer never invents a second domain taxonomy.
 *
 * Adding a term is a reviewed one-line edit here. Two invariant tests assert that
 * activation specs and events only ever use terms declared in this file, so the
 * vocabulary cannot silently drift.
 */

/** Normalized lifecycle phases, host-independent. */
export const PHASES = [
  "prompt",
  "pre_tool",
  "post_tool",
  "file_read",
  "file_write",
  "command",
  "subagent",
  "compact",
  "stop",
] as const;
export type Phase = (typeof PHASES)[number];

/**
 * The constrained OPERATION vocabulary. An operation is the abstract *action* an
 * event performs, independent of host or exact command. Derived deterministically
 * from a parsed command + tool + touched files (see `features.ts`). Keep this list
 * short and semantic — it is the primary activation axis after domain.
 */
export const OPERATIONS = [
  "package_install",
  "package_remove",
  "package_run",
  "test_run",
  "migration_edit",
  "migration_run",
  "db_query",
  "deploy",
  "log_write",
  "lint",
  "format",
  "file_read",
  "file_edit",
  "file_write",
  "git_op",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/**
 * ARTIFACT types — a tiny set of structurally-recognizable file roles. Derived from
 * a path's basename/location, never from file contents. Used both as a relevance
 * axis ("this spec cares about lockfiles") and for conflict triggers ("editing a
 * generated file").
 */
export const ARTIFACTS = [
  "manifest", // package.json, pyproject.toml, Cargo.toml, go.mod
  "lockfile", // package-lock.json, bun.lock(b), yarn.lock, pnpm-lock.yaml
  "migration", // files under a migrations/ dir or *.sql migration
  "logger", // a logging module (logger.*, log.*)
  "test", // *.test.*, *.spec.*, files under tests/ or __tests__/
  "env_file", // .env, .env.*
  "generated", // *.generated.*, dist/, build/, *.min.*, lockfiles double here
  "ci", // .github/workflows/*, CI config
] as const;
export type Artifact = (typeof ARTIFACTS)[number];

/**
 * Conservative TOKEN CUES for the security/secret path (§16). These are
 * identifier-shaped substrings that, combined with a `log_write` operation and the
 * security/logging domain state, make a "never log secrets" rule a *conflict* — not
 * arbitrary regex secret detection. Matched case-insensitively against observational
 * event text (a command string or an edited snippet), never stored.
 */
export const SECRET_TOKEN_CUES = [
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "privatekey",
  "private_key",
  "credential",
  "authtoken",
  "auth_token",
  "bearer",
  "sessiontoken",
  "session_token",
  "client_secret",
] as const;

export const PHASE_SET: ReadonlySet<string> = new Set(PHASES);
export const OPERATION_SET: ReadonlySet<string> = new Set(OPERATIONS);
export const ARTIFACT_SET: ReadonlySet<string> = new Set(ARTIFACTS);
