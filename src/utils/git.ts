import { execFileSync } from "node:child_process";

function runGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** Absolute path to the repository root, or null if `cwd` is not inside a git repo. */
export function gitToplevel(cwd: string): string | null {
  return runGit(["rev-parse", "--show-toplevel"], cwd);
}

/** The `origin` remote URL, or null if there is no origin remote. */
export function gitOriginUrl(cwd: string): string | null {
  return runGit(["remote", "get-url", "origin"], cwd);
}
