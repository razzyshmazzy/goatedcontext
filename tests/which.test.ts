import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";

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
