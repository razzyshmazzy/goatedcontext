import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeRemote, detectRepoIdentity } from "../src/core/repos/repo.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { makeGitRepo } from "./helpers.ts";

/**
 * Repo-identity & path/home edge cases (0.3.0 diagnostic). Identity canonicalization
 * is what keys repo-scoped retrieval; a mismatch is cross-repo leakage or a split
 * identity. Path resolution must never silently duplicate the DB.
 */

// ── repo identity canonicalization ───────────────────────────────────────────

test("transport / credentials / trailing slash / .git / host case all collapse to ONE identity", () => {
  const forms = [
    "git@github.com:acme/app.git",
    "https://github.com/acme/app.git",
    "https://github.com/acme/app",
    "https://github.com/acme/app/",
    "https://user:token@github.com/acme/app.git",
    "ssh://git@github.com/acme/app.git",
    "https://GitHub.com/acme/app",
  ];
  const canonical = forms.map((f) => canonicalizeRemote(f));
  for (const c of canonical) expect(c).toBe("github.com/acme/app");
});

test("repository PATH case is preserved (hosts may be case-sensitive on the path)", () => {
  // Only the HOST is lowercased; two different-cased paths must NOT merge.
  expect(canonicalizeRemote("https://github.com/Acme/App")).toBe("github.com/Acme/App");
  expect(canonicalizeRemote("https://github.com/acme/app")).not.toBe(canonicalizeRemote("https://github.com/Acme/App"));
});

test("a real repo with a remote yields a stable remote: identity; a no-remote repo yields path:", () => {
  const withRemote = makeGitRepo("https://github.com/acme/edge.git");
  try {
    const id = detectRepoIdentity(withRemote.root)!;
    expect(id.identity).toBe("remote:github.com/acme/edge");
    expect(id.hasRemote).toBe(true);
  } finally {
    withRemote.cleanup();
  }
});

test("FINDING(P3): a no-remote repo's identity is a hash of the EXACT root path (moves/symlinks/case split identity)", () => {
  // Document the known MVP limitation: without a remote, identity = path hash, so the
  // same repo reached via a different path string (symlink, different case on Windows,
  // renamed dir) is treated as a DIFFERENT repo. We assert the shape, not a specific hash.
  const { execFileSync } = require("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "ctx-noremote-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    const id = detectRepoIdentity(root)!;
    expect(id.identity.startsWith("path:")).toBe(true);
    expect(id.hasRemote).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── path / home resolution ───────────────────────────────────────────────────

test("CTX_HOME override wins verbatim and is not normalized/duplicated", () => {
  const spaces = "C:\\Users\\Jane Doe\\OneDrive\\.ctx";
  expect(resolvePaths({ CTX_HOME: spaces } as NodeJS.ProcessEnv).home).toBe(spaces);
  const unicode = "/home/tëst/项目/.ctx";
  expect(resolvePaths({ CTX_HOME: unicode } as NodeJS.ProcessEnv).home).toBe(unicode);
  // Derived paths live UNDER the chosen home — one home, one db file.
  const p = resolvePaths({ CTX_HOME: spaces } as NodeJS.ProcessEnv);
  expect(p.dbFile.startsWith(spaces)).toBe(true);
  expect(p.configFile.startsWith(spaces)).toBe(true);
  expect(p.secretsFile.startsWith(spaces)).toBe(true);
});

test("blank/whitespace CTX_HOME falls back to <homedir>/.ctx (never an empty-string home)", () => {
  expect(resolvePaths({ CTX_HOME: "" } as NodeJS.ProcessEnv).home).not.toBe("");
  expect(resolvePaths({ CTX_HOME: "   " } as NodeJS.ProcessEnv).home).not.toBe("   ");
  // Two resolutions with the same (default) inputs agree → no accidental DB split.
  expect(resolvePaths({} as NodeJS.ProcessEnv).home).toBe(resolvePaths({} as NodeJS.ProcessEnv).home);
});

test("a deeply-nested / long CTX_HOME path resolves without truncation", () => {
  const deep = "/tmp/" + Array.from({ length: 30 }, (_, i) => `level${i}`).join("/") + "/.ctx";
  expect(resolvePaths({ CTX_HOME: deep } as NodeJS.ProcessEnv).home).toBe(deep);
});
