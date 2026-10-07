import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const isWindows = process.platform === "win32";

/**
 * Resolve where an atomic write should actually land, preserving user filesystem
 * ownership (Wave 3). If `path` is a SYMLINK we mutate its TARGET and keep the link
 * entry intact — never replace the user's symlink with a regular file. A dangling or
 * looping link is refused (we must not silently create/replace it). Also reports the
 * existing file's permission bits so the write can PRESERVE them (an existing 0600
 * config must not become 0644); null means the file is new.
 */
function resolveAtomicTarget(path: string): { target: string; existingMode: number | null } {
  let linkStat;
  try {
    linkStat = lstatSync(path);
  } catch {
    return { target: path, existingMode: null }; // nothing there yet → new file at `path`
  }
  if (linkStat.isSymbolicLink()) {
    let real: string;
    try {
      real = realpathSync(path); // follows the chain; throws on a loop or dangling target
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP") {
        throw new Error(`Refusing to write ${path}: symlink loop. Fix the link and retry.`);
      }
      throw new Error(
        `Refusing to write ${path}: it is a dangling symlink (its target is missing). ` +
          `Repair or remove the link rather than letting ctx replace it.`,
      );
    }
    let mode: number | null = null;
    try {
      mode = statSync(real).mode & 0o777;
    } catch {
      /* target vanished between realpath and stat — treat as new */
    }
    return { target: real, existingMode: mode };
  }
  return { target: path, existingMode: linkStat.mode & 0o777 };
}

/** Blocking sleep without spinning the CPU (used only inside lock backoff). */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Windows transient filesystem errors: another process mid-operation on the same
 * path, or an antivirus/indexer briefly holding a handle. The operation is still
 * correct; it just needs to be retried until the window clears.
 */
const TRANSIENT_FS = new Set(["EPERM", "EACCES", "EBUSY"]);
function isTransientFs(err: unknown): boolean {
  return TRANSIENT_FS.has((err as NodeJS.ErrnoException).code ?? "");
}

/**
 * Write a file atomically: write to a unique temp file in the same directory,
 * fsync it, then rename over the destination. A crash mid-write leaves the
 * original file intact (or absent) — never a truncated/partial file.
 *
 * Filesystem-ownership preservation (Wave 3):
 *  - a SYMLINK at `path` is followed: we replace its TARGET and keep the link entry,
 *    so ctx never turns a user's symlinked config into a plain file (dangling/looping
 *    links are refused, not clobbered);
 *  - an EXISTING file's permission bits are PRESERVED (a 0600 config stays 0600); the
 *    `mode` argument applies only when creating a NEW file.
 */
export function writeFileAtomic(
  path: string,
  data: string | Buffer,
  mode = 0o600,
): void {
  const { target, existingMode } = resolveAtomicTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  // Preserve the existing file's mode (so a 0600 config is never weakened to 0644); use
  // the caller's intended mode for a new file. POSIX only — on Windows these bits are
  // synthetic and chmod is meaningless, so we never apply POSIX expectations there.
  const effectiveMode = !isWindows && existingMode != null ? existingMode : mode;

  // Retry the whole open→write→fsync→rename cycle on transient Windows FS errors
  // (temp-file open or the rename swap can both hit EPERM/EACCES/EBUSY under
  // concurrent access or AV interference). The write stays atomic each attempt.
  for (let attempt = 0; ; attempt++) {
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      const fd = openSync(tmp, "w", effectiveMode);
      try {
        writeSync(fd, buf);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // openSync's mode is masked by umask; set the exact bits so a preserved 0600 or an
      // intended-secure new file is guaranteed. No-op semantics on Windows, so skip it.
      if (!isWindows) {
        try {
          chmodSync(tmp, effectiveMode);
        } catch {
          /* best-effort: mode tightening is advisory on filesystems that ignore it */
        }
      }
      renameSync(tmp, target);
      return;
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      if (!isTransientFs(err) || attempt >= 20) throw err;
      sleepSync(15);
    }
  }
}

export interface FileLockOptions {
  /** Max time to wait to acquire the lock before throwing. */
  timeoutMs?: number;
  /** A lock file older than this is considered stale and stolen. */
  staleMs?: number;
}

/**
 * Run `fn` while holding an exclusive advisory lock implemented as an
 * O_EXCL lock file. Used to serialize read-modify-write cycles on mutable
 * plain files (secret store, Claude instruction file) across processes.
 *
 * SQLite correctness does NOT rely on this — the database has its own locking.
 * This is only for non-DB files that several processes might rewrite at once.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // fails if the lock file already exists
      try {
        writeSync(fd, `${process.pid}`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && !isTransientFs(err)) throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`);
      }
      if (code === "EEXIST") {
        // If the existing lock is stale, steal it and retry immediately.
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between open and stat — retry immediately
        }
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}
