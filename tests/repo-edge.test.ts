import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeRemote, detectRepoIdentity, RepoService } from "../src/core/repos/repo.ts";
import { openMemoryDatabase } from "../src/storage/sqlite/db.ts";

const TIMEOUT = 60_000;

// ---- helpers ----------------------------------------------------------------

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function initRepo(dir: string, origin?: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  if (origin) git(["remote", "add", "origin", origin], dir);
}

function commit(dir: string): void {
  writeFileSync(join(dir, "file.txt"), "hello", "utf8");
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], dir);
}

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

// ---- canonicalizeRemote (unit) ----------------------------------------------

test("ssh, https and credentialed URLs canonicalize identically", () => {
  const id = "github.com/acme/app";
  expect(canonicalizeRemote("git@github.com:acme/app.git")).toBe(id);
  expect(canonicalizeRemote("https://github.com/acme/app.git")).toBe(id);
  expect(canonicalizeRemote("https://user:pass@github.com/acme/app")).toBe(id);
  expect(canonicalizeRemote("ssh://git@github.com/acme/app.git")).toBe(id);
});

test("a trailing slash does not fork the identity", () => {
  expect(canonicalizeRemote("https://github.com/acme/app/")).toBe("github.com/acme/app");
  expect(canonicalizeRemote("https://github.com/acme/app.git/")).toBe("github.com/acme/app");
});

test("host case is normalized (git hosts are case-insensitive)", () => {
  expect(canonicalizeRemote("https://GitHub.com/acme/app")).toBe("github.com/acme/app");
  expect(canonicalizeRemote("git@GITHUB.com:acme/app.git")).toBe("github.com/acme/app");
  expect(canonicalizeRemote("https://GitHub.com/acme/app")).toBe(
    canonicalizeRemote("git@github.com:acme/app.git"),
  );
});

test("repo path case is preserved (host paths may be case-sensitive)", () => {
  // Only the host is lowercased; the path keeps its case to avoid merging
  // genuinely distinct repos on case-sensitive hosts.
  expect(canonicalizeRemote("https://github.com/Acme/App")).toBe("github.com/Acme/App");
});

test("empty / whitespace remote yields null", () => {
  expect(canonicalizeRemote("")).toBeNull();
  expect(canonicalizeRemote("   ")).toBeNull();
});

// ---- real-git integration ---------------------------------------------------

test(
  "no-remote repo gets a stable path-based identity",
  () => {
    const dir = join(tmp("ctx-git-noremote-"), "plain");
    initRepo(dir);
    const a = detectRepoIdentity(dir);
    const b = detectRepoIdentity(dir);
    expect(a).not.toBeNull();
    expect(a!.identity.startsWith("path:")).toBe(true);
    expect(a!.hasRemote).toBe(false);
    expect(a!.identity).toBe(b!.identity); // stable in place
    rmSync(dir, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "remote-backed identity ignores the local path entirely",
  () => {
    const one = join(tmp("ctx-git-remote-"), "checkout-one");
    initRepo(one, "https://github.com/acme/app.git");
    const detected = detectRepoIdentity(one)!;
    expect(detected.identity).toBe("remote:github.com/acme/app");
    expect(detected.name).toBe("app");
    expect(detected.hasRemote).toBe(true);
    rmSync(one, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "the same remote cloned twice resolves to ONE repo record",
  () => {
    const a = join(tmp("ctx-git-twice-a-"), "a");
    const b = join(tmp("ctx-git-twice-b-"), "b");
    initRepo(a, "git@github.com:acme/app.git");
    initRepo(b, "https://github.com/acme/app.git"); // same repo, different transport
    const db = openMemoryDatabase();
    try {
      const repos = new RepoService(db);
      const ra = repos.resolve(a)!;
      const rb = repos.resolve(b)!;
      expect(ra.id).toBe(rb.id); // deduped by identity
      expect(repos.list()).toHaveLength(1);
    } finally {
      db.close();
    }
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "paths with spaces resolve correctly",
  () => {
    const dir = join(tmp("ctx-git-space-"), "my repo dir");
    initRepo(dir);
    const detected = detectRepoIdentity(dir)!;
    expect(detected).not.toBeNull();
    expect(detected.name).toBe("my repo dir");
    rmSync(dir, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "unicode paths resolve correctly",
  () => {
    const dir = join(tmp("ctx-git-unicode-"), "café-日本-repo");
    initRepo(dir);
    const detected = detectRepoIdentity(dir)!;
    expect(detected).not.toBeNull();
    expect(detected.name).toBe("café-日本-repo");
    rmSync(dir, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "nested repos each resolve to their own innermost root",
  () => {
    const parent = join(tmp("ctx-git-nested-"), "parent");
    initRepo(parent, "https://github.com/acme/parent.git");
    const child = join(parent, "vendored", "child");
    initRepo(child, "https://github.com/acme/child.git");

    const pId = detectRepoIdentity(parent)!;
    const cId = detectRepoIdentity(child)!;
    expect(pId.identity).toBe("remote:github.com/acme/parent");
    expect(cId.identity).toBe("remote:github.com/acme/child");
    expect(pId.identity).not.toBe(cId.identity);
    rmSync(parent, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "a worktree of a remote-backed repo shares the repo's identity",
  () => {
    const main = join(tmp("ctx-git-wt-"), "main");
    initRepo(main, "https://github.com/acme/app.git");
    commit(main);
    const wt = join(tmp("ctx-git-wt2-"), "wt");
    const res = git(["worktree", "add", "-q", wt], main);
    if (res.exitCode !== 0) {
      // Environment can't create worktrees — skip rather than flake.
      rmSync(main, { recursive: true, force: true });
      return;
    }
    const mainId = detectRepoIdentity(main)!;
    const wtId = detectRepoIdentity(wt)!;
    expect(wtId.identity).toBe(mainId.identity); // both use the shared remote
    rmSync(main, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "a submodule resolves to its own repository, not the superproject",
  () => {
    const sourceDir = join(tmp("ctx-git-sub-src-"), "lib");
    initRepo(sourceDir, "https://github.com/acme/lib.git");
    commit(sourceDir);

    const superDir = join(tmp("ctx-git-super-"), "app");
    initRepo(superDir, "https://github.com/acme/app.git");
    commit(superDir);

    // Local-path submodules require the file protocol to be explicitly allowed on
    // modern git; if that's unavailable, skip rather than flake.
    const add = git(
      ["-c", "protocol.file.allow=always", "submodule", "add", sourceDir, "lib"],
      superDir,
    );
    const subPath = join(superDir, "lib");
    if (add.exitCode !== 0) {
      rmSync(superDir, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
      return;
    }
    // `git submodule add <local-path>` records the local path as origin; in the
    // real world a submodule has a URL. Point it at one to mirror that.
    git(["remote", "set-url", "origin", "https://github.com/acme/lib.git"], subPath);

    const subId = detectRepoIdentity(subPath)!;
    const superId = detectRepoIdentity(superDir)!;
    // The submodule resolves to its OWN repository (via its gitlink), not the super.
    expect(subId.identity).toBe("remote:github.com/acme/lib");
    expect(subId.identity).not.toBe(superId.identity);
    rmSync(superDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "a moved no-remote repo is treated as new (documented limitation)",
  () => {
    const base = tmp("ctx-git-move-");
    const a = join(base, "a");
    initRepo(a);
    const before = detectRepoIdentity(a)!;
    const b = join(base, "b");
    renameSync(a, b);
    const after = detectRepoIdentity(b)!;
    // Path-based identity changes when the directory moves — the known MVP tradeoff.
    expect(before.identity).not.toBe(after.identity);
    rmSync(base, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "Windows drive-letter case differences do not fork a no-remote identity",
  () => {
    if (process.platform !== "win32") return; // git path-case normalization is Windows-specific
    const base = tmp("ctx-git-case-");
    const dir = join(base, "Repo");
    initRepo(dir);
    const a = detectRepoIdentity(dir)!;
    const flipped = dir[0] === dir[0]!.toUpperCase()
      ? dir[0]!.toLowerCase() + dir.slice(1)
      : dir[0]!.toUpperCase() + dir.slice(1);
    const b = detectRepoIdentity(flipped)!;
    // git rev-parse --show-toplevel normalizes the drive letter, so identity is stable.
    expect(b.identity).toBe(a.identity);
    rmSync(base, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "a moved repo WITH a remote keeps its identity across the move",
  () => {
    const base = tmp("ctx-git-move2-");
    const a = join(base, "a");
    initRepo(a, "https://github.com/acme/app.git");
    const before = detectRepoIdentity(a)!;
    const b = join(base, "b");
    renameSync(a, b);
    const after = detectRepoIdentity(b)!;
    expect(before.identity).toBe(after.identity); // remote identity is path-independent
    rmSync(base, { recursive: true, force: true });
  },
  TIMEOUT,
);
