import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync, captureChild, describeChildFailure } from "../src/utils/runtime.ts";

// Regression: whichSync must resolve a command that ALREADY carries its extension
// (e.g. the Windows "ctx.cmd" launcher). PATHEXT never contains "", so the ext-only
// PATH search used to miss the literal file and return null — which made `ctx doctor`'s
// mcp-launchable / windows-ctx-command checks falsely warn even when ctx was on PATH.

const isWin = process.platform === "win32";
// Windows FS is case-insensitive and PATH resolution may return the PATHEXT casing
// (e.g. ".CMD") rather than the file's on-disk ".cmd"; compare case-insensitively there.
const eq = (a: string | null, b: string) => expect(isWin ? a?.toLowerCase() : a).toBe(isWin ? b.toLowerCase() : b);

test("resolves a file whose name already includes its extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-which-"));
  try {
    const name = isWin ? "ctxresolve.cmd" : "ctxresolve.sh";
    const file = join(dir, name);
    writeFileSync(file, isWin ? "@echo off\r\n" : "#!/bin/sh\n");
    if (!isWin) chmodSync(file, 0o755);
    eq(whichSync(name, dir), file); // the exact file, found on PATH
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still resolves a bare command name via PATHEXT (Windows) / directly (POSIX)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-which-"));
  try {
    if (isWin) {
      writeFileSync(join(dir, "ctxbare.cmd"), "@echo off\r\n");
      eq(whichSync("ctxbare", dir), join(dir, "ctxbare.cmd"));
    } else {
      const f = join(dir, "ctxbare");
      writeFileSync(f, "#!/bin/sh\n");
      chmodSync(f, 0o755);
      eq(whichSync("ctxbare", dir), f);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null when the command is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-which-"));
  try {
    expect(whichSync("definitely-not-here.cmd", dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression (the `ctx setup` "npm global install failed: unknown error" bug): npm, yarn
// and pnpm ship an EXTENSIONLESS POSIX shell script (e.g. "npm") right next to their
// Windows ".cmd" launcher. whichSync used to probe the bare name first and return that
// script; Node's spawn cannot execute it without a shell, so every `npm` child failed
// with ENOENT. A bare command name must resolve the PATHEXT (.cmd) form, NOT the sibling
// extensionless script. On POSIX (exts = [""]) the extensionless file is the right answer.
test("bare command prefers its PATHEXT (.cmd) form over a sibling extensionless script", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-which-"));
  try {
    // Both files present, exactly like a real Windows Node install's `npm` + `npm.cmd`.
    const bare = join(dir, "npmlike");
    writeFileSync(bare, "#!/bin/sh\nexit 0\n");
    if (!isWin) chmodSync(bare, 0o755);
    writeFileSync(join(dir, "npmlike.cmd"), "@echo off\r\n");
    const resolved = whichSync("npmlike", dir);
    if (isWin) {
      eq(resolved, join(dir, "npmlike.cmd")); // the spawnable launcher, never the script
    } else {
      eq(resolved, bare); // POSIX: the extensionless script IS the executable
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A failed child must expose its ACTUAL reason — never collapse to "unknown error".
// This is the second half of the setup bug: captureChild dropped the spawn error, so a
// spawn ENOENT left both streams empty and surfaced as "unknown error".
test("captureChild + describeChildFailure surface a real reason for a missing command", () => {
  const res = captureChild("ctx-definitely-missing-binary-xyz", ["--version"]);
  expect(res.code).not.toBe(0);
  // The spawn failed at the OS level: a spawn error is present and no exit signal.
  expect(res.error).toBeDefined();
  const detail = describeChildFailure("ctx-definitely-missing-binary-xyz --version", res);
  expect(detail.toLowerCase()).not.toContain("unknown error");
  expect(detail).toContain("spawn error:");
  expect(detail).toContain("ctx-definitely-missing-binary-xyz");
});
