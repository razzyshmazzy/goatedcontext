/** Write to a stream, swallowing EPIPE (downstream pipe closed, e.g. `| head`). */
function safeWrite(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(0);
    }
    throw err;
  }
}

/** Print a JSON value as pretty output for scripting (`--json`). */
export function printJson(value: unknown): void {
  safeWrite(process.stdout, JSON.stringify(value, null, 2) + "\n");
}

/** Print a normal human-facing line. */
export function line(msg = ""): void {
  safeWrite(process.stdout, msg + "\n");
}

/** Print to stderr (diagnostics, warnings). */
export function warn(msg: string): void {
  safeWrite(process.stderr, msg + "\n");
}
