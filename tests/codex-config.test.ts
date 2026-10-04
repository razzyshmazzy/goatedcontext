import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensureCodexWritableRoot,
  codexWritableRootConfigured,
  codexConfigFile,
  tomlRootValue,
  canonicalRoot,
} from "../src/adapters/codex/config.ts";
import { resolvePaths } from "../src/storage/paths.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-codex-config-"));
}
const WIN = "win32" as NodeJS.Platform;
const NIX = "linux" as NodeJS.Platform;

// ── §19 effective ctx home resolution ─────────────────────────────────────────

test("CTX_HOME resolution: Windows & POSIX defaults and overrides agree everywhere", () => {
  // Overrides are platform-agnostic: the env value wins verbatim.
  expect(resolvePaths({ CTX_HOME: "D:\\ctx-data" } as NodeJS.ProcessEnv).home).toBe("D:\\ctx-data");
  expect(resolvePaths({ CTX_HOME: "/tmp/custom-ctx" } as NodeJS.ProcessEnv).home).toBe("/tmp/custom-ctx");
  // Default (no override) is <homedir>/.ctx — the one resolver install/doctor/runtime share.
  expect(resolvePaths({} as NodeJS.ProcessEnv).home).toBe(join(homedir(), ".ctx"));
  // A blank/whitespace CTX_HOME falls back to the default (not the empty string).
  expect(resolvePaths({ CTX_HOME: "   " } as NodeJS.ProcessEnv).home).toBe(join(homedir(), ".ctx"));
});

test("install, doctor, and runtime read the SAME effective ctx home (no disagreement)", () => {
  const home = dir();
  try {
    const env = { CTX_HOME: join(home, ".ctx") } as NodeJS.ProcessEnv;
    const ctxHome = resolvePaths(env).home;
    const cfg = codexConfigFile(home);
    // "install" writes the root resolved from env …
    ensureCodexWritableRoot(cfg, ctxHome, NIX);
    // … and the read-back check resolves the identical value.
    expect(codexWritableRootConfigured(cfg, resolvePaths(env).home, NIX)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── path normalization helpers (§6) ───────────────────────────────────────────

test("tomlRootValue: Windows backslashes become forward slashes; POSIX verbatim", () => {
  expect(tomlRootValue("C:\\Users\\Admin\\.ctx", WIN)).toBe("C:/Users/Admin/.ctx");
  expect(tomlRootValue("/home/test/.ctx", NIX)).toBe("/home/test/.ctx");
  // A POSIX path containing a backslash (a legal filename char) is NOT mangled.
  expect(tomlRootValue("/home/weird\\dir/.ctx", NIX)).toBe("/home/weird\\dir/.ctx");
});

test("canonicalRoot: Windows is slash- and case-insensitive; POSIX is neither", () => {
  expect(canonicalRoot("C:\\Users\\Admin\\.ctx", WIN)).toBe(canonicalRoot("C:/Users/Admin/.ctx", WIN));
  expect(canonicalRoot("c:\\users\\admin\\.ctx", WIN)).toBe(canonicalRoot("C:\\Users\\Admin\\.ctx", WIN));
  // POSIX keeps case and does not fold backslashes.
  expect(canonicalRoot("/home/Test/.ctx", NIX)).not.toBe(canonicalRoot("/home/test/.ctx", NIX));
  // Trailing slash is ignored on both.
  expect(canonicalRoot("/home/test/.ctx/", NIX)).toBe(canonicalRoot("/home/test/.ctx", NIX));
});

// ── §20 config-merge matrix ───────────────────────────────────────────────────

test("1. no existing config → creates a minimal valid config with the ctx writable root", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("created");
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain("[sandbox_workspace_write]");
    expect(text).toContain('writable_roots = ["/home/test/.ctx"]');
    expect(codexWritableRootConfigured(cfg, "/home/test/.ctx", NIX)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("2. existing unrelated config is fully preserved; our table is appended", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    const original = `# my codex config\nmodel = "gpt-5"\napproval_policy = "on-request"\n\n[mcp_servers.fs]\ncommand = "fs-server"\n`;
    writeFileSync(cfg, original);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("added");
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain(original.trimEnd()); // every original byte preserved
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[mcp_servers.fs]");
    expect(text).toContain("[sandbox_workspace_write]");
    expect(codexWritableRootConfigured(cfg, "/home/test/.ctx", NIX)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3. existing writable_roots: ctx appended, existing roots preserved", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    writeFileSync(
      cfg,
      `sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nnetwork_access = false\nwritable_roots = ["/srv/shared", "/opt/fixtures"]\n`,
    );
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("added");
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain("/srv/shared");
    expect(text).toContain("/opt/fixtures");
    expect(text).toContain("/home/test/.ctx");
    expect(text).toContain("network_access = false"); // sibling key untouched
    expect(codexWritableRootConfigured(cfg, "/home/test/.ctx", NIX)).toBe(true);
    expect(codexWritableRootConfigured(cfg, "/srv/shared", NIX)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("4. ctx root already present → no duplicate (present, byte-stable)", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    writeFileSync(cfg, `[sandbox_workspace_write]\nwritable_roots = ["/home/test/.ctx"]\n`);
    const before = readFileSync(cfg, "utf8");
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("present");
    expect(readFileSync(cfg, "utf8")).toBe(before); // untouched
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("5. slash-equivalent Windows path already present → no duplicate", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    writeFileSync(cfg, `[sandbox_workspace_write]\nwritable_roots = ["C:/Users/Admin/.ctx"]\n`);
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\Admin\\.ctx", WIN);
    expect(r.action).toBe("present");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("6. case-equivalent Windows path already present → no duplicate", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    writeFileSync(cfg, `[sandbox_workspace_write]\nwritable_roots = ["c:\\\\users\\\\admin\\\\.ctx"]\n`);
    // (Stored as a basic string with escaped backslashes; canonical compare folds it.)
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\Admin\\.ctx", WIN);
    expect(r.action).toBe("present");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("7. malformed config → untouched + actionable error", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    const malformed = `[sandbox_workspace_write]\nwritable_roots = ["unterminated\n`;
    writeFileSync(cfg, malformed);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("error");
    expect(r.detail && r.detail.length).toBeTruthy();
    expect(readFileSync(cfg, "utf8")).toBe(malformed); // never clobbered
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("7b. garbage (non-TOML) config → untouched + error, never destroyed", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    const garbage = `this is not toml at all <<< >>> nonsense`;
    writeFileSync(cfg, garbage);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("error");
    expect(readFileSync(cfg, "utf8")).toBe(garbage);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("8. repeated install is idempotent and byte-stable after the first convergence", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    expect(ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX).action).toBe("created");
    const afterFirst = readFileSync(cfg, "utf8");
    expect(ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX).action).toBe("present");
    expect(ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX).action).toBe("present");
    expect(readFileSync(cfg, "utf8")).toBe(afterFirst);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("9. a custom CTX_HOME override path is used verbatim", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    ensureCodexWritableRoot(cfg, "D:\\ctx-data", WIN);
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain('writable_roots = ["D:/ctx-data"]');
    expect(codexWritableRootConfigured(cfg, "D:\\ctx-data", WIN)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("10. a path containing spaces produces a valid, round-trippable config", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    const spaced = "C:\\Users\\Jane Doe\\.ctx";
    ensureCodexWritableRoot(cfg, spaced, WIN);
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain('writable_roots = ["C:/Users/Jane Doe/.ctx"]');
    expect(codexWritableRootConfigured(cfg, spaced, WIN)).toBe(true);
    // Idempotent even with spaces.
    expect(ensureCodexWritableRoot(cfg, spaced, WIN).action).toBe("present");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── defensive extras: comments, multiline arrays, dotted keys ─────────────────

test("multiline writable_roots array: ctx appended, existing entries preserved", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    writeFileSync(
      cfg,
      `[sandbox_workspace_write]\nwritable_roots = [\n  "/srv/a",\n  "/srv/b",\n]\n`,
    );
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("added");
    expect(codexWritableRootConfigured(cfg, "/srv/a", NIX)).toBe(true);
    expect(codexWritableRootConfigured(cfg, "/srv/b", NIX)).toBe(true);
    expect(codexWritableRootConfigured(cfg, "/home/test/.ctx", NIX)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("table present but writable_roots key absent → key inserted inside the table", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    writeFileSync(cfg, `[sandbox_workspace_write]\nnetwork_access = true\n`);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("added");
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain("network_access = true");
    expect(codexWritableRootConfigured(cfg, "/home/test/.ctx", NIX)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dotted-key form (sandbox_workspace_write.writable_roots) is detected, not duplicated", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    writeFileSync(cfg, `sandbox_workspace_write.writable_roots = ["/home/test/.ctx"]\n`);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("present");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dotted-key partial table without writable_roots → safe refusal (no illegal redefinition)", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    const original = `sandbox_workspace_write.network_access = true\n`;
    writeFileSync(cfg, original);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("error");
    expect(readFileSync(cfg, "utf8")).toBe(original); // untouched
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("comments and unrelated tables after an appended table are preserved", () => {
  const home = dir();
  try {
    const cfg = codexConfigFile(home);
    const original = `# top comment\nmodel = "gpt-5"\n`;
    writeFileSync(cfg, original);
    ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    const text = readFileSync(cfg, "utf8");
    expect(text.startsWith("# top comment")).toBe(true);
    expect(existsSync(cfg)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
