import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
    for (const ext of exts) {
      const candidate = base + ext;
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
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
 * Run a command with the parent's stdio inherited (used by `ctx env run`).
 * Returns the child's exit code. Throws only if the process could not be spawned.
 */
export function runChildInherit(cmd: string, args: string[], opts: ChildOptions = {}): number {
  const res = spawnPortable(cmd, args, opts, "inherit");
  if (res.error) throw res.error;
  return res.status ?? 0;
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
