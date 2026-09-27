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
