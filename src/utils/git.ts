import { execFileSync } from "node:child_process";

/**
 * Default hard ceiling on any git subprocess (ms). Git metadata lookups (repo root,
 * origin URL) are local and complete in a few ms; this bound only ever triggers when
 * git HANGS — a network filesystem, a stuck credential/hook prompt, an unresponsive
 * mount. Without it a single hung git would block `ctx get`/`hook` (the prompt hot
 * path) indefinitely. On timeout the child is killed and the call fails SAFE
 * (returns null → the existing "no repo"/"no remote" fallback), so a hang degrades
 * to running without repo context rather than freezing the agent.
 *
 * Not a user-facing setting. `CTX_GIT_TIMEOUT_MS` overrides it for tests and the rare
 * genuinely-slow environment; `CTX_GIT_BIN` overrides the git executable likewise.
 */
const GIT_TIMEOUT_MS = 5000;

function gitTimeoutMs(): number {
  const raw = process.env.CTX_GIT_TIMEOUT_MS;
  if (!raw) return GIT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return GIT_TIMEOUT_MS;
  return Math.min(60_000, Math.max(50, n));
}

/**
 * Run a git command with a bounded timeout. Returns the trimmed stdout, or null on
 * ANY failure — non-zero exit, git-not-found, or a timeout (the child is then killed
 * with SIGTERM). Callers treat null as "git could not answer" and fall back.
 *
 * `CTX_GIT_BIN` (internal/test) overrides the executable; a `.mjs`/`.js`/`.cjs`
 * value is run via the current runtime so a tiny fake-git script can simulate slow or
 * malformed git deterministically without installing anything.
 */
function runGit(args: string[], cwd: string): string | null {
  const bin = process.env.CTX_GIT_BIN?.trim() || "git";
  let file = bin;
  let fullArgs = args;
  if (/\.(mjs|cjs|js)$/i.test(bin)) {
    file = process.execPath;
    fullArgs = [bin, ...args];
  }
  try {
    const out = execFileSync(file, fullArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: gitTimeoutMs(),
      killSignal: "SIGTERM",
      windowsHide: true,
    });
    return out.trim();
  } catch {
    // Non-zero exit, ENOENT (no git), or ETIMEDOUT (hung → killed): fail safe.
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

/**
 * A REQUEST-LOCAL git memoizer. Within a single ctx invocation, the same repo-root /
 * origin lookup for a given `cwd` is resolved at most once and reused, instead of
 * re-spawning git. This is deliberately NOT a long-lived cross-request cache: a probe
 * lives only as long as the one operation that created it (e.g. one CLI command), so
 * it can never serve stale repo state to a later request. Create one per request and
 * pass it to `detectRepoIdentity`/`RepoService.resolve`; omit it to get a fresh
 * (non-memoizing) single-shot lookup, identical to calling git directly.
 */
export interface GitProbe {
  toplevel(cwd: string): string | null;
  originUrl(cwd: string): string | null;
}

export function createGitProbe(): GitProbe {
  const topl = new Map<string, string | null>();
  const orig = new Map<string, string | null>();
  return {
    toplevel(cwd) {
      if (!topl.has(cwd)) topl.set(cwd, gitToplevel(cwd));
      return topl.get(cwd)!;
    },
    originUrl(cwd) {
      if (!orig.has(cwd)) orig.set(cwd, gitOriginUrl(cwd));
      return orig.get(cwd)!;
    },
  };
}
