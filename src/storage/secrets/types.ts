import { CtxError } from "../../utils/errors.ts";

/**
 * The on-disk secret store exists but cannot be parsed/decoded. We must NEVER treat
 * this as an empty store and overwrite it (that would destroy encrypted entries).
 * Callers surface this and leave every byte of the original file untouched.
 */
export class CorruptSecretStoreError extends CtxError {
  constructor(file: string) {
    super(`secrets store is corrupted and was not modified. Back up or repair ${file} before writing new secrets.`);
    this.name = "CorruptSecretStoreError";
  }
}

/**
 * Encrypted secrets exist on disk but their encryption key is gone. Regenerating a
 * key would make the existing ciphertext permanently undecryptable, so we fail closed
 * and leave all files untouched. A new key is only ever created for an empty store.
 */
export class MissingSecretKeyError extends CtxError {
  constructor() {
    super(
      "encryption key is missing; existing encrypted secrets cannot be read. " +
        "Restore the key file, or remove the secrets store to start over.",
    );
    this.name = "MissingSecretKeyError";
  }
}

/**
 * A secret/env value cannot be used safely as an environment variable by the
 * supported runtime (e.g. it contains a NUL byte). The value itself is NEVER
 * included in the message.
 */
export class InvalidSecretValueError extends CtxError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSecretValueError";
  }
}

/**
 * Validate that `value` can be used as an environment-variable value by the supported
 * runtime (Node/Bun `spawn`). Node rejects NUL bytes in both env keys and values,
 * and the thrown error ECHOES the value — so we reject at the earliest boundary and
 * NEVER put the value in the error. `varName` (already shape-validated by callers) is
 * safe to name. Deliberately narrow: only genuinely unsupported bytes are rejected.
 */
export function assertUsableEnvValue(value: string, varName?: string): void {
  if (value.includes("\0")) {
    const where = varName ? ` for "${varName}"` : "";
    throw new InvalidSecretValueError(
      `secret value${where} contains a NUL byte and cannot be used as an environment variable.`,
    );
  }
}

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
