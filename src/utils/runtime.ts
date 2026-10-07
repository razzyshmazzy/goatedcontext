import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Runtime-compatibility helpers.
 *
 * Production code must run under both Bun (development, `bun test`) and a normal
 * Node install (the published CLI). These helpers wrap the few pieces that used to
 * call Bun-specific globals (`Bun.stdin`, `Bun.spawn`, `Bun.which`, `Bun.version`)
 * with `node:` equivalents that behave the same on either runtime.
 */

/** Human-readable label for the current runtime, e.g. "Bun 1.4.2" or "Node v24.14.0". */
export function runtimeLabel(): string {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  if (bun && typeof bun.version === "string") return `Bun ${bun.version}`;
  return `Node ${process.version}`;
}

/** Read all of stdin to a UTF-8 string (used by the hook and `ctx import -`). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a single line from stdin (used by `ctx env set` so a secret value never
 * lands in shell history). Stops at the first newline and never echoes.
 */
export async function readStdinLine(): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += decoder.decode(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    const nl = buf.indexOf("\n");
    if (nl !== -1) {
      buf = buf.slice(0, nl);
      break;
    }
  }
  return buf.replace(/\r$/, "");
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Executable extensions to probe on Windows (PATHEXT), or [""] elsewhere. */
function execExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((e) => e.trim()).filter(Boolean);
}

/**
 * Cross-platform `which`: resolve an executable to a concrete path using PATH,
 * honoring PATHEXT on Windows. Returns null if not found. A Node/Bun-agnostic
 * replacement for `Bun.which`.
 */
export function whichSync(cmd: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (!cmd) return null;
  const exts = execExtensions();

  // An explicit path (absolute or relative): probe it directly, then with each ext.
  if (cmd.includes("/") || cmd.includes("\\")) {
    if (isFile(cmd)) return cmd;
    for (const ext of exts) if (ext && isFile(cmd + ext)) return cmd + ext;
    return null;
  }

  for (const dir of (pathEnv ?? "").split(delimiter).filter(Boolean)) {
    const base = join(dir, cmd);
    // Probe the bare name first so a command that ALREADY carries its extension
    // (e.g. "ctx.cmd" on Windows) resolves — PATHEXT never includes "", so the
    // ext loop alone would only ever try "ctx.cmd.CMD" and miss the real file.
    if (isFile(base)) return base;
    for (const ext of exts) {
      const candidate = base + ext;
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * True for bin directories that only exist for the lifetime of a single command
 * and therefore must never be treated as the user's PERSISTENT `ctx` location.
 *
 * The motivating case: `npx goatedcontext setup` runs inside a process whose PATH
 * npm has PREPENDED with the npx cache's package bin, e.g.
 *   <cache>/_npx/<hash>/node_modules/.bin
 * That directory holds a `ctx` shim for the just-downloaded package, so a naive
 * `which("ctx")` resolves the EPHEMERAL npx copy — at the running version — instead
 * of the user's installed launcher, tricking setup into "already current".
 *
 * A globally-installed CLI never lives in a `node_modules/.bin` (npm places global
 * bins directly in the global prefix), so dropping these entries cannot hide a
 * legitimate persistent launcher.
 */
function isEphemeralBinDir(dir: string): boolean {
  const norm = dir.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!norm) return true;
  if (norm.split("/").includes("_npx")) return true; // npx (npm 7+) temp package
  if (norm.endsWith("/node_modules/.bin")) return true; // project/temp package bin
  return false;
}

/**
 * A copy of PATH with ephemeral bin directories removed, so callers can resolve the
 * launcher the user's PERSISTENT shell would resolve — never a temporary one npx (or
 * a local `node_modules/.bin`) injected only for the current process. See
 * {@link isEphemeralBinDir}.
 */
export function persistentPath(pathEnv: string | undefined = process.env.PATH): string {
  return (pathEnv ?? "")
    .split(delimiter)
    .filter((dir) => dir && !isEphemeralBinDir(dir))
    .join(delimiter);
}

/**
 * True when a resolved filesystem path lives inside an EPHEMERAL npm cache — most
 * importantly the npx cache (`.../_npx/<hash>/...`). A persistent global package must
 * NEVER resolve into such a directory: `npm install -g <local-dir>` pointed at an npx
 * cache package will LINK the global install back into that cache, and the cache is
 * transient. Detecting this lets setup treat such an install as broken and reinstall
 * from the registry. Kept path-only (no fs access) so it is trivially unit-testable.
 */
export function resolvesIntoEphemeralCache(p: string): boolean {
  const norm = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!norm) return false;
  if (norm.split("/").includes("_npx")) return true; // npx (npm 7+) temp package cache
  if (norm.includes("/node_modules/.bin")) return true; // never where a package lives
  return false;
}

export interface ChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Quote an argument for a Windows `cmd.exe` command line, only when needed. */
function winQuote(arg: string): string {
  return /[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Windows requires `.cmd`/`.bat` shims (npm, etc.) to run through a shell, and
 * modern Node refuses to spawn them without `shell: true`. When that applies we
 * build a properly-quoted command line so paths containing spaces still work.
 * Everything else (POSIX, and `.exe` on Windows) runs shell-free with the args
 * array passed through untouched — no quoting pitfalls, no injection surface.
 */
function spawnPortable(
  cmd: string,
  args: string[],
  opts: ChildOptions,
  stdio: "inherit" | "pipe",
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const resolved = whichSync(cmd, opts.env?.PATH ?? process.env.PATH) ?? cmd;
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);

  if (needsShell) {
    const line = [winQuote(resolved), ...args.map(winQuote)].join(" ");
    const res = spawnSync(line, {
      cwd: opts.cwd,
      env: opts.env,
      stdio,
      shell: true,
      windowsHide: true,
      encoding: stdio === "pipe" ? "utf8" : undefined,
    });
    return { status: res.status, stdout: (res.stdout as string) ?? "", stderr: (res.stderr as string) ?? "", error: res.error };
  }

  const res = spawnSync(resolved, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio,
    windowsHide: true,
    encoding: stdio === "pipe" ? "utf8" : undefined,
  });
  return { status: res.status, stdout: (res.stdout as string) ?? "", stderr: (res.stderr as string) ?? "", error: res.error };
}

/**
 * Translate a child's termination into a shell-style exit code.
 *   - normal numeric exit  → that code unchanged (`exit 7` → 7)
 *   - killed by a signal    → 128 + signal number (SIGTERM → 143, SIGKILL → 137,
 *     SIGPIPE → 141), the POSIX convention `sh`/`bash` use
 *   - unknown/undecodable signal → 1 (nonzero; never a false success)
 *   - NEITHER code nor signal → 1 (fail closed)
 *
 * A signal death must NEVER map to 0 — that was the bug where `status ?? 0`
 * reported success for a SIGTERM/SIGKILL/SIGPIPE child.
 *
 * The `null`/`null` branch is not reachable on the `env run` path: after a
 * successfully-spawned child, Node/Bun's `exit` event sets EXACTLY ONE of (code,
 * signal) — verified empirically (exit→(code,null); signal-kill→(null,signal)) and per
 * the child_process contract (a spawn failure goes to `error`, which the caller turns
 * into a reject, not here). We still fail CLOSED rather than return 0: a child that
 * ended with no exit code AND no signal carries no evidence of success, so treating it
 * as success would be unsafe.
 */
export function exitCodeFromChild(code: number | null, signal: NodeJS.Signals | null): number {
  if (code != null) return code;
  if (signal != null) {
    const num = (osConstants.signals as Record<string, number | undefined>)[signal];
    return typeof num === "number" && num > 0 ? 128 + num : 1;
  }
  return 1;
}

/** Signals ctx forwards to a live `env run` child. SIGHUP is POSIX-only. */
function forwardableSignals(): NodeJS.Signals[] {
  return process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/**
 * Run a command with the parent's stdio inherited (used by `ctx env run`), forwarding
 * termination signals to the child and propagating its true exit status.
 *
 * Why async `spawn` (not `spawnSync`): a synchronous spawn blocks the event loop, so
 * ctx's own signal handlers can never run — if ctx is sent SIGTERM while the child is
 * live, ctx dies and the child is orphaned. With async spawn we install handlers for
 * the duration of the child's life that forward the signal to the child, then await the
 * child's exit and return the correct (possibly signal-derived) code. Handlers are
 * removed in `finally`, so they never leak or affect unrelated commands.
 *
 * Rejects only if the process could not be spawned (e.g. command not found).
 */
export function runChildInherit(cmd: string, args: string[], opts: ChildOptions = {}): Promise<number> {
  const resolved = whichSync(cmd, opts.env?.PATH ?? process.env.PATH) ?? cmd;
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);

  const child = needsShell
    ? spawn([winQuote(resolved), ...args.map(winQuote)].join(" "), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: "inherit",
        shell: true,
        windowsHide: true,
      })
    : spawn(resolved, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: "inherit",
        windowsHide: true,
      });

  // Forward termination signals to the child for the lifetime of the child only.
  // One received signal → exactly one forwarded signal (no double-send). Installing a
  // SIGINT listener also stops Node's default (which would kill ctx and strand the
  // child); we wait for the child, then return its signal-derived code — Ctrl-C is
  // neither swallowed nor turned into exit 0.
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const sig of forwardableSignals()) {
    const handler = () => {
      try {
        child.kill(sig);
      } catch {
        /* child already gone — nothing to forward */
      }
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }

  return new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(exitCodeFromChild(code, signal)));
  }).finally(() => {
    for (const [sig, handler] of handlers) process.removeListener(sig, handler);
  });
}

/** Run a command and capture its output (used by `ctx setup` for npm queries). */
export function captureChild(
  cmd: string,
  args: string[],
  opts: ChildOptions = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnPortable(cmd, args, opts, "pipe");
  return { code: res.status ?? (res.error ? 1 : 0), stdout: res.stdout, stderr: res.stderr };
}
