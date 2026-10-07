import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/storage/secrets/file-backend.ts";
import {
  CorruptSecretStoreError,
  MissingSecretKeyError,
  InvalidSecretValueError,
} from "../src/storage/secrets/types.ts";

/**
 * Secret-store destructive-boundary regressions (security wave).
 *
 * These prove the three unacceptable behaviors are now IMPOSSIBLE:
 *   1. a corrupt secrets.json is never silently overwritten
 *   2. a missing key never auto-regenerates while ciphertext exists
 *   3. a NUL-byte value is rejected before it can ever reach a subprocess env
 */

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "ctx-secsafe-"));
  const secretsFile = join(dir, "secrets.json");
  const keyFile = join(dir, "secret.key");
  return { dir, secretsFile, keyFile, store: new FileSecretStore(secretsFile, keyFile) };
}

// ── 1. corrupted secrets.json ─────────────────────────────────────────────────

test("valid store update round-trips and preserves other entries", () => {
  const { dir, store } = freshStore();
  try {
    store.set("env:e:A", "alpha");
    store.set("env:e:B", "bravo");
    store.set("env:e:A", "alpha2"); // overwrite one
    expect(store.get("env:e:A")).toBe("alpha2");
    expect(store.get("env:e:B")).toBe("bravo"); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nonexistent store creation works (new empty store)", () => {
  const { dir, secretsFile, keyFile, store } = freshStore();
  try {
    expect(existsSync(secretsFile)).toBe(false);
    store.set("env:e:A", "v");
    expect(existsSync(secretsFile)).toBe(true);
    expect(existsSync(keyFile)).toBe(true);
    expect(store.get("env:e:A")).toBe("v");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, bytes] of [
  ["malformed JSON", "{ not json <<CORRUPT-SENTINEL>>"],
  ["truncated JSON", '{"env:e:A": {"iv":"AAA","tag":"BBB","dat'],
  ["invalid encrypted payload shape", '{"env:e:A": {"iv": 123, "nope": true}}'],
  ["non-object root", '["CORRUPT-SENTINEL"]'],
] as const) {
  test(`${label}: write fails and original bytes are preserved`, () => {
    const { dir, secretsFile, store } = freshStore();
    try {
      writeFileSync(secretsFile, bytes);
      expect(() => store.set("env:e:NEW", "value")).toThrow(CorruptSecretStoreError);
      expect(readFileSync(secretsFile, "utf8")).toBe(bytes); // untouched
      // delete must also refuse to touch a corrupt store
      expect(() => store.delete("env:e:NEW")).toThrow(CorruptSecretStoreError);
      expect(readFileSync(secretsFile, "utf8")).toBe(bytes);
      // the error must never contain stored bytes beyond the file path
      try {
        store.set("env:e:NEW", "value");
      } catch (e) {
        expect((e as Error).message).not.toContain("CORRUPT-SENTINEL");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ── 2. missing secret.key ──────────────────────────────────────────────────────

test("missing key with existing ciphertext: get fails closed, nothing regenerated", () => {
  const { dir, secretsFile, keyFile, store } = freshStore();
  try {
    store.set("env:e:A", "orig");
    const secretsBefore = readFileSync(secretsFile, "utf8");
    unlinkSync(keyFile); // key disappears, ciphertext remains

    expect(() => store.get("env:e:A")).toThrow(MissingSecretKeyError);
    expect(existsSync(keyFile)).toBe(false); // NOT regenerated on read
    expect(readFileSync(secretsFile, "utf8")).toBe(secretsBefore); // ciphertext untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing key with existing ciphertext: set refuses rather than orphaning data", () => {
  const { dir, secretsFile, keyFile, store } = freshStore();
  try {
    store.set("env:e:A", "orig");
    const secretsBefore = readFileSync(secretsFile, "utf8");
    unlinkSync(keyFile);

    expect(() => store.set("env:e:B", "second")).toThrow(MissingSecretKeyError);
    expect(existsSync(keyFile)).toBe(false); // no replacement key created
    expect(readFileSync(secretsFile, "utf8")).toBe(secretsBefore); // original entries intact
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key IS generated for a genuinely new/empty store", () => {
  const { dir, secretsFile, keyFile, store } = freshStore();
  try {
    writeFileSync(secretsFile, "{}\n"); // empty but present store, no key yet
    store.set("env:e:A", "v");
    expect(existsSync(keyFile)).toBe(true);
    expect(store.get("env:e:A")).toBe("v");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. NUL-byte value rejected at the storage boundary ─────────────────────────

test("a NUL-byte value is rejected before persistence, without echoing the value", () => {
  const { dir, secretsFile, store } = freshStore();
  try {
    const SECRET = "sk-LEAKY\0SECRET";
    let msg = "";
    try {
      store.set("env:e:A", SECRET);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSecretValueError);
      msg = (e as Error).message;
    }
    expect(msg).not.toContain("sk-LEAKY");
    expect(msg).not.toContain("SECRET");
    expect(existsSync(secretsFile)).toBe(false); // nothing persisted
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
