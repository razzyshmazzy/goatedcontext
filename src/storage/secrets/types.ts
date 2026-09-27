/**
 * Storage abstraction for secret VALUES (tokens, API keys, passwords).
 *
 * This interface is deliberately tiny and free of any ctx domain concepts so an
 * OS-keychain backend can be dropped in without touching callers.
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
  /** A stable machine-readable name for the active backend. */
  readonly backend: string;
  /** Inspectable posture, surfaced by `ctx status`. */
  describe(): SecretBackendInfo;
}

export interface SecretBackendInfo {
  /** Machine-readable backend id, e.g. "windows-dpapi" or "encrypted-file". */
  backend: string;
  /** True when the encryption key is NOT stored on disk next to the data. */
  secure: boolean;
  /** Human-readable description of the protection and its limits. */
  note: string;
}

/** Build the reference key used for an environment variable's secret. */
export function envVarSecretRef(environmentId: string, varName: string): string {
  return `env:${environmentId}:${varName}`;
}
