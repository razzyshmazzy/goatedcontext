import { existsSync, readFileSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { SecretStore, SecretBackendInfo } from "./types.ts";
import { writeFileAtomic, withFileLock } from "../../utils/fs.ts";

interface EncryptedEntry {
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
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

  private key(): Buffer {
    if (existsSync(this.keyFile)) return readFileSync(this.keyFile);
    const key = randomBytes(32);
    writeFileAtomic(this.keyFile, key, 0o600);
    return key;
  }

  private readAll(): Record<string, EncryptedEntry> {
    if (!existsSync(this.secretsFile)) return {};
    try {
      return JSON.parse(readFileSync(this.secretsFile, "utf8"));
    } catch {
      return {};
    }
  }

  private writeAll(entries: Record<string, EncryptedEntry>): void {
    writeFileAtomic(this.secretsFile, JSON.stringify(entries, null, 2) + "\n", 0o600);
  }

  set(ref: string, value: string): void {
    const key = this.key();
    withFileLock(this.lockFile, () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const entries = this.readAll();
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
    const key = this.key();
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
