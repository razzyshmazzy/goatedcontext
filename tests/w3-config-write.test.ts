import { test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  lstatSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/utils/fs.ts";
import { upsertPromptHook, detectPromptHook } from "../src/adapters/claude/hook.ts";

/**
 * Safe config write primitive (Wave 3 §8-11): preserve symlinks, preserve file mode,
 * and never report a mutation that did not happen.
 */

const POSIX = process.platform !== "win32";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-cfgwrite-"));
}

// ── mode preservation (POSIX) ─────────────────────────────────────────────────

test.if(POSIX)("writeFileAtomic preserves an existing file's 0600 mode (not 0644)", () => {
  const d = dir();
  try {
    const f = join(d, "settings.json");
    writeFileSync(f, "{}");
    chmodSync(f, 0o600);
    writeFileAtomic(f, '{"a":1}\n', 0o644); // caller asks for 0644, but existing is 0600
    expect(statSync(f).mode & 0o777).toBe(0o600); // preserved, not weakened
    expect(readFileSync(f, "utf8")).toContain('"a"');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test.if(POSIX)("writeFileAtomic applies the intended mode to a NEW file", () => {
  const d = dir();
  try {
    const secret = join(d, "secret.key");
    writeFileAtomic(secret, "k", 0o600);
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    const pub = join(d, "pub.json");
    writeFileAtomic(pub, "{}", 0o644);
    expect(statSync(pub).mode & 0o777).toBe(0o644);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── symlink preservation (POSIX) ──────────────────────────────────────────────

test.if(POSIX)("writeFileAtomic follows a symlink and preserves the link entry", () => {
  const d = dir();
  try {
    const target = join(d, "real-settings.json");
    const link = join(d, "settings.json");
    writeFileSync(target, "{}");
    symlinkSync(target, link);

    writeFileAtomic(link, '{"updated":true}\n', 0o644);

    expect(lstatSync(link).isSymbolicLink()).toBe(true); // link NOT replaced by a file
    expect(readFileSync(target, "utf8")).toContain("updated"); // the TARGET was updated
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test.if(POSIX)("writeFileAtomic refuses a dangling symlink rather than replacing it", () => {
  const d = dir();
  try {
    const link = join(d, "settings.json");
    symlinkSync(join(d, "does-not-exist.json"), link);
    expect(() => writeFileAtomic(link, "{}", 0o644)).toThrow(/dangling symlink/i);
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // link preserved, not clobbered
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── truthful mutation result (cross-platform) ─────────────────────────────────

test("upsertPromptHook reports 'error' and does not write when settings.json is malformed", () => {
  const d = dir();
  try {
    const f = join(d, "settings.json");
    const malformed = "{ not valid json ]]";
    writeFileSync(f, malformed);
    const action = upsertPromptHook(f, "ctx hook claude-prompt");
    expect(action).toBe("error"); // NOT "created"/"updated"
    expect(readFileSync(f, "utf8")).toBe(malformed); // untouched
    expect(detectPromptHook(f)).toBe(false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("upsertPromptHook reports created→unchanged truthfully on a clean file", () => {
  const d = dir();
  try {
    const f = join(d, "settings.json");
    expect(upsertPromptHook(f, "ctx hook claude-prompt")).toBe("created");
    expect(upsertPromptHook(f, "ctx hook claude-prompt")).toBe("unchanged");
    expect(detectPromptHook(f)).toBe(true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
