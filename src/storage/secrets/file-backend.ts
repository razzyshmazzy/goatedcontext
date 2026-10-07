import { existsSync, readFileSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { SecretStore, SecretBackendInfo } from "./types.ts";
import {
  CorruptSecretStoreError,
  MissingSecretKeyError,
  assertUsableEnvValue,
} from "./types.ts";
import { writeFileAtomic, withFileLock } from "../../utils/fs.ts";

interface EncryptedEntry {
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
}

/** A parsed store must be a plain object of well-shaped encrypted entries. */
function isEncryptedEntry(v: unknown): v is EncryptedEntry {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.iv === "string" && typeof e.tag === "string" && typeof e.data === "string";
}

/**
 * Encrypted local-file secret backend (the portable fallback).
 *
 * Secrets are encrypted with AES-256-GCM. The 32-byte key lives in a separate
 * file (`secret.key`); the encrypted blob lives in `secrets.json`. Both are
 * written atomically (temp file + rename) and read-modify-write cycles are
 * serialized with an O_EXCL lock file, so concurrent `env set` operations never
 * truncate or lose data.
 *
 * LIMITATION (surfaced by `ctx status`): the key sits next to the data on the
 * same machine, so anyone who can read `~/.ctx/secrets/` can decrypt everything.
 * This keeps plaintext out of SQLite and off casual inspection, but it is NOT an
 * OS keychain. On Windows the intended 0600 mode is not enforced by the OS.
 */
export class FileSecretStore implements SecretStore {
  readonly backend = "encrypted-file";
  private readonly secretsFile: string;
  private readonly keyFile: string;
  private readonly lockFile: string;

  constructor(secretsFile: string, keyFile: string) {
    this.secretsFile = secretsFile;
    this.keyFile = keyFile;
    this.lockFile = secretsFile + ".lock";
  }

  describe(): SecretBackendInfo {
    return {
      backend: this.backend,
      secure: false,
      note:
        "AES-256-GCM at rest, but the encryption key is stored on the same machine " +
        "next to the data. Anyone who can read the secrets directory can decrypt it. " +
        "Not equivalent to an OS keychain.",
    };
  }

  /** Load the existing encryption key, or null if no key file exists. Never generates. */
  private loadKey(): Buffer | null {
    if (!existsSync(this.keyFile)) return null;
    return readFileSync(this.keyFile);
  }

  /**
   * Read the current store. Distinguishes the three boundary cases explicitly:
   *   - file absent (or empty)        → `{}` (a valid new/empty store; nothing to lose)
   *   - file present and well-formed  → the parsed, shape-validated entries
   *   - file present but un-parseable → throw `CorruptSecretStoreError` (NO mutation)
   *
   * A parse/shape/read failure MUST NOT be collapsed to `{}`: that path once let a
   * subsequent write silently replace a corrupt store and destroy real secrets.
   */
  private readAll(): Record<string, EncryptedEntry> {
    if (!existsSync(this.secretsFile)) return {};
    let raw: string;
    try {
      raw = readFileSync(this.secretsFile, "utf8");
    } catch {
      // The file exists but cannot be read — fail closed, never treat as empty.
      throw new CorruptSecretStoreError(this.secretsFile);
    }
    if (raw.trim().length === 0) return {}; // zero-byte file: no entries to preserve
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CorruptSecretStoreError(this.secretsFile);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CorruptSecretStoreError(this.secretsFile);
    }
    const out: Record<string, EncryptedEntry> = {};
    for (const [ref, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isEncryptedEntry(entry)) throw new CorruptSecretStoreError(this.secretsFile);
      out[ref] = entry;
    }
    return out;
  }

  private writeAll(entries: Record<string, EncryptedEntry>): void {
    writeFileAtomic(this.secretsFile, JSON.stringify(entries, null, 2) + "\n", 0o600);
  }

  set(ref: string, value: string): void {
    // Reject values that cannot be used as an environment variable BEFORE persisting
    // (e.g. a NUL byte). Validating here also protects the direct-store path, not just
    // the env-service caller. The value is never included in the error.
    assertUsableEnvValue(value);
    withFileLock(this.lockFile, () => {
      // Read the current (valid) state first; a corrupt store throws here, before any
      // key generation or write, so corruption can never be silently overwritten.
      const entries = this.readAll();
      // Resolve the key INSIDE the lock. On a brand-new store two concurrent `set`s
      // would otherwise each see no key file and generate a DIFFERENT key; the losing
      // writer's entry would then be permanently undecryptable. Under the lock the
      // first writer creates the key and the second reads it, so both agree.
      //
      // A key is generated ONLY for a store with no existing entries. If ciphertext
      // already exists but the key is gone, generating a replacement would orphan every
      // existing secret forever — so we fail closed instead.
      let key = this.loadKey();
      if (key == null) {
        if (Object.keys(entries).length > 0) throw new MissingSecretKeyError();
        key = randomBytes(32);
        writeFileAtomic(this.keyFile, key, 0o600);
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      entries[ref] = {
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: encrypted.toString("base64"),
      };
      this.writeAll(entries);
    });
  }

  get(ref: string): string | null {
    const entry = this.readAll()[ref];
    if (!entry) return null;
    // Ciphertext exists for this ref. If the key is gone we CANNOT read it and must
    // NOT fabricate a new key (that would never match the stored ciphertext); fail
    // closed so the caller reports the value as unavailable rather than silently wrong.
    const key = this.loadKey();
    if (key == null) throw new MissingSecretKeyError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(entry.data, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      return null;
    }
  }

  has(ref: string): boolean {
    return Boolean(this.readAll()[ref]);
  }

  delete(ref: string): void {
    withFileLock(this.lockFile, () => {
      const entries = this.readAll();
      if (ref in entries) {
        delete entries[ref];
        this.writeAll(entries);
      }
    });
  }
}
