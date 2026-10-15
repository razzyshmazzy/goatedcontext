/**
 * The ONLY stateful terminal surface. It enters the alternate screen, hides the cursor,
 * disables auto-wrap and turns on raw mode — and guarantees the inverse on the way out.
 * `cleanup()` is idempotent and restores EVERYTHING (raw mode, cursor, wrap, alt screen)
 * so the shell is never left broken on quit, Ctrl-C or an exception (spec §18).
 *
 * Streams are injected so the whole lifecycle can be driven by a fake TTY in tests.
 */

export interface TermStdin {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(enc: string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface TermStdout {
  columns?: number;
  rows?: number;
  write(data: string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface TermIO {
  stdin: TermStdin;
  stdout: TermStdout;
}

const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H";
const LEAVE = "\x1b[?7h\x1b[?25h\x1b[?1049l";

export interface Terminal {
  size(): { cols: number; rows: number };
  write(data: string): void;
  onKey(cb: (data: string) => void): void;
  onResize(cb: () => void): void;
  cleanup(): void;
}

export function createTerminal(io: TermIO): Terminal {
  const { stdin, stdout } = io;
  let cleaned = false;
  const dataListeners: ((...args: unknown[]) => void)[] = [];
  const resizeListeners: ((...args: unknown[]) => void)[] = [];

  stdout.write(ENTER);
  if (typeof stdin.setRawMode === "function" && stdin.isTTY !== false) {
    try {
      stdin.setRawMode(true);
    } catch {
      /* some environments disallow raw mode; input still works line-buffered */
    }
  }
  stdin.setEncoding?.("utf8");
  stdin.resume?.();

  function off(target: TermStdin | TermStdout, event: string, listener: (...a: unknown[]) => void): void {
    (target.off ?? target.removeListener)?.call(target, event, listener);
  }

  return {
    size() {
      return { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
    },
    write(data: string) {
      if (!cleaned) stdout.write(data);
    },
    onKey(cb) {
      const listener = (...args: unknown[]) => cb(String(args[0] ?? ""));
      dataListeners.push(listener);
      stdin.on("data", listener);
    },
    onResize(cb) {
      const listener = () => cb();
      resizeListeners.push(listener);
      stdout.on("resize", listener);
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const l of dataListeners) off(stdin, "data", l);
      for (const l of resizeListeners) off(stdout, "resize", l);
      if (typeof stdin.setRawMode === "function" && stdin.isTTY !== false) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      stdin.pause?.();
      stdout.write(LEAVE);
    },
  };
}
