import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The single source of truth for the CLI version is `package.json`.
 *
 * The BUILT artifact carries the version as a compile-time constant: the build
 * (`scripts/build.mjs`) reads `package.json` and injects it via a `--define`
 * replacement of `__CTX_VERSION__`. The bundle therefore knows its own version
 * without ever locating a `package.json` at runtime.
 *
 * When running from source under Bun (dev/tests), the define is absent, so we
 * fall back to reading the repository's `package.json` relative to this file.
 * This fallback exists ONLY for the un-built dev path and is dead code in the
 * shipped bundle.
 */
declare const __CTX_VERSION__: string;

function devVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: string };
        if (parsed.version) return parsed.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through to a safe default */
  }
  return "0.0.0-dev";
}

/** The CLI version, matching `package.json`. */
export const VERSION: string =
  typeof __CTX_VERSION__ !== "undefined" ? __CTX_VERSION__ : devVersion();
