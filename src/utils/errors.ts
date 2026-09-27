/**
 * A user-facing error. The CLI prints `message` cleanly (without a stack trace)
 * and exits with `exitCode`.
 */
export class CtxError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CtxError";
    this.exitCode = exitCode;
  }
}

/** Thrown when a referenced record cannot be found. */
export class NotFoundError extends CtxError {
  constructor(message: string) {
    super(message, 4);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when an optimistic-concurrency check fails: the record changed since the
 * caller last observed it, so the write is refused rather than clobbering newer
 * state. Exit code 5 lets scripts distinguish this from other failures.
 */
export class ConflictError extends CtxError {
  constructor(message: string) {
    super(message, 5);
    this.name = "ConflictError";
  }
}

/** Thrown when a validated write receives invalid input. Exit code 2. */
export class ValidationError extends CtxError {
  constructor(message: string) {
    super(message, 2);
    this.name = "ValidationError";
  }
}
