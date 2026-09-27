import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { SecretStore } from "./types.ts";

interface EncryptedEntry {
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
}

/**
 * Encrypted local-file secret backend.
 *
 * Secrets are encrypted with AES-256-GCM. The 32-byte key lives in a separate
 * file (`secret.key`) created on first use with `0600` permissions; the
 * encrypted blob lives in `secrets.json`, also `0600`.
 *
 * LIMITATION: this protects secrets at rest against casual disk inspection and
 * keeps plaintext out of SQLite, but the key sits next to the data on the same
 * machine. It is NOT equivalent to a hardware-backed OS keychain. The
 * `SecretStore` interface exists precisely so a keychain backend can replace
 * this one later without changing any callers.
 */
export class FileSecretStore implements SecretStore {
  readonly backend = "encrypted-file";
  private readonly secretsFile: string;
  private readonly keyFile: string;

  constructor(secretsFile: string, keyFile: string) {
    this.secretsFile = secretsFile;
    this.keyFile = keyFile;
  }

  private key(): Buffer {
    if (existsSync(this.keyFile)) {
      return readFileSync(this.keyFile);
    }
    mkdirSync(dirname(this.keyFile), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(this.keyFile, key, { mode: 0o600 });
    tryChmod(this.keyFile, 0o600);
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
    mkdirSync(dirname(this.secretsFile), { recursive: true });
    writeFileSync(this.secretsFile, JSON.stringify(entries, null, 2) + "\n", {
      mode: 0o600,
    });
    tryChmod(this.secretsFile, 0o600);
  }

  set(ref: string, value: string): void {
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const entries = this.readAll();
    entries[ref] = {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    };
    this.writeAll(entries);
  }

  get(ref: string): string | null {
    const entries = this.readAll();
    const entry = entries[ref];
    if (!entry) return null;
    const key = this.key();
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(entry.iv, "base64"),
      );
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
    const entries = this.readAll();
    if (ref in entries) {
      delete entries[ref];
      this.writeAll(entries);
    }
  }
}

function tryChmod(path: string, mode: number): void {
  // chmod is a no-op / may throw on some Windows filesystems; ignore failures.
  try {
    chmodSync(path, mode);
  } catch {
    /* ignore */
  }
}
