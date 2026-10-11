/**
 * Per-trial isolation (spec §27, §33).
 *
 * Every trial runs against a THROWAWAY ctx home and a THROWAWAY git repo. Nothing ever
 * touches the developer's real `~/.ctx`. The control condition additionally scrubs every
 * ctx env var so goatedcontext cannot possibly participate (verified in conditions.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
  /** Root temp dir for this trial (contains ctxHome/ and repo/). */
  root: string;
  /** Isolated CTX_HOME — passed to `ctx` so it never reads the real store. */
  ctxHome: string;
  /** A real git repo (so repo-scoped preferences and repo identity resolve). */
  repo: string;
  cleanup: () => void;
}

/** Minimal language seeds so file-extension / framework scorers read naturally. */
const LANGUAGE_SEED: Record<string, (repo: string) => void> = {
  typescript: (r) => {
    writeFileSync(join(r, "package.json"), JSON.stringify({ name: "sandbox", private: true, type: "module" }, null, 2));
    writeFileSync(join(r, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "index.ts"), "export const ok = true;\n");
  },
  javascript: (r) => {
    writeFileSync(join(r, "package.json"), JSON.stringify({ name: "sandbox", private: true }, null, 2));
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "index.js"), "module.exports = { ok: true };\n");
  },
  python: (r) => {
    writeFileSync(join(r, "pyproject.toml"), '[project]\nname = "sandbox"\nversion = "0.0.0"\n');
    mkdirSync(join(r, "sandbox"), { recursive: true });
    writeFileSync(join(r, "sandbox", "__init__.py"), "");
  },
  go: (r) => {
    writeFileSync(join(r, "go.mod"), "module sandbox\n\ngo 1.22\n");
    writeFileSync(join(r, "main.go"), "package main\n\nfunc main() {}\n");
  },
  rust: (r) => {
    writeFileSync(join(r, "Cargo.toml"), '[package]\nname = "sandbox"\nversion = "0.0.0"\nedition = "2021"\n');
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "main.rs"), "fn main() {}\n");
  },
};

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

export interface SandboxOptions {
  /** Language to seed the repo as (default typescript). */
  language?: string;
  /**
   * Deterministic repo remote identity. Distinct per scenario so repo-scoped
   * preferences get a stable `remote:…` identity and cross-repo leakage (§7/§16)
   * can be tested by pointing a second sandbox at a different remote.
   */
  remote?: string;
}

/** Initialize a git repo at `dir` with a deterministic remote + language seed. */
export function createRepo(dir: string, opts: SandboxOptions = {}): void {
  mkdirSync(dir, { recursive: true });
  const remote = opts.remote ?? "https://github.com/ctxbench/sandbox.git";
  git(dir, ["init", "-q"]);
  git(dir, ["remote", "add", "origin", remote]);
  // Local identity so commits (if any) never fail and never read global git config.
  git(dir, ["config", "user.email", "bench@ctxbench.local"]);
  git(dir, ["config", "user.name", "ctxbench"]);
  const seed = LANGUAGE_SEED[(opts.language ?? "typescript").toLowerCase()] ?? LANGUAGE_SEED.typescript!;
  seed(dir);
}

export function makeSandbox(opts: SandboxOptions = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ctxbench-"));
  const ctxHome = join(root, "ctx-home");
  const repo = join(root, "repo");
  mkdirSync(ctxHome, { recursive: true });
  createRepo(repo, opts);

  return {
    root,
    ctxHome,
    repo,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort; a held file on Windows is non-fatal for a temp dir */
      }
    },
  };
}

/** Write a repo-relative file (used to plant poisoning content before a probe). */
export function plantFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, relPath);
  const dir = abs.slice(0, Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\")));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
}
