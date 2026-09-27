import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

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
 */
export function writeFileAtomic(
  path: string,
  data: string | Buffer,
  mode = 0o600,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;

  // Retry the whole open→write→fsync→rename cycle on transient Windows FS errors
  // (temp-file open or the rename swap can both hit EPERM/EACCES/EBUSY under
  // concurrent access or AV interference). The write stays atomic each attempt.
  for (let attempt = 0; ; attempt++) {
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      const fd = openSync(tmp, "w", mode);
      try {
        writeSync(fd, buf);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
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
