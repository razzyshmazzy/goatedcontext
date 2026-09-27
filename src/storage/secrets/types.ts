/**
 * Storage abstraction for secret VALUES (tokens, API keys, passwords).
 *
 * This interface is deliberately tiny and free of any ctx domain concepts so an
 * OS-keychain backend (macOS Keychain, Windows Credential Manager, libsecret)
 * can be dropped in later without touching callers.
 *
 * Hard rules enforced by every implementation and its callers:
 *  - secret values are NEVER written to SQLite
 *  - secret values are NEVER printed to stdout/stderr by ctx
 *  - secret values are NEVER surfaced by `ctx get`
 */
export interface SecretStore {
  /** Store (or overwrite) a secret value under an opaque reference. */
  set(ref: string, value: string): void;
  /** Retrieve a secret value, or null if the reference is unknown. */
  get(ref: string): string | null;
  /** Whether a value exists for the reference. Does not reveal the value. */
  has(ref: string): boolean;
  /** Remove a secret value. No-op if the reference is unknown. */
  delete(ref: string): void;
  /** A human-readable name for the active backend, for diagnostics. */
  readonly backend: string;
}

/** Build the reference key used for an environment variable's secret. */
export function envVarSecretRef(environmentId: string, varName: string): string {
  return `env:${environmentId}:${varName}`;
}
