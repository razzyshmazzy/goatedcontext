/** Print a JSON value as pretty output for scripting (`--json`). */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Print a normal human-facing line. */
export function line(msg = ""): void {
  process.stdout.write(msg + "\n");
}

/** Print to stderr (diagnostics, warnings). */
export function warn(msg: string): void {
  process.stderr.write(msg + "\n");
}
