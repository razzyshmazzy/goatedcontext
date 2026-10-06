import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { CtxPaths } from "./paths.ts";
import { nowIso } from "../utils/time.ts";
import { writeFileAtomic, withFileLock } from "../utils/fs.ts";
import { CtxError } from "../utils/errors.ts";

export const ConfigSchema = z.object({
  version: z.number().int().default(1),
  createdAt: z.string(),
  /** Default number of preferences returned by `ctx get`. Clamped to [1, 15]. */
  retrievalLimit: z.number().int().min(1).max(15).default(12),
});

export type Config = z.infer<typeof ConfigSchema>;

function defaultConfig(): Config {
  return { version: 1, createdAt: nowIso(), retrievalLimit: 12 };
}

export function ensureHome(paths: CtxPaths): void {
  if (!existsSync(paths.home)) mkdirSync(paths.home, { recursive: true });
  if (!existsSync(paths.secretsDir)) mkdirSync(paths.secretsDir, { recursive: true });
}

export function loadConfig(paths: CtxPaths): Config {
  if (!existsSync(paths.configFile)) {
    // Serialize first-time creation so concurrent inits don't all race to write
    // and rename the same file. Re-check inside the lock.
    ensureHome(paths);
    return withFileLock(paths.configFile + ".lock", () => {
      if (!existsSync(paths.configFile)) {
        const cfg = defaultConfig();
        saveConfig(paths, cfg);
        return cfg;
      }
      return parseConfig(readFileSync(paths.configFile, "utf8"), paths.configFile);
    });
  }
  return parseConfig(readFileSync(paths.configFile, "utf8"), paths.configFile);
}

/**
 * Parse + validate config.json, turning a raw JSON `SyntaxError` or schema mismatch
 * into an actionable `CtxError` (what failed + where + the fix) instead of a bare
 * stack trace on every command when the file is hand-corrupted.
 */
function parseConfig(text: string, file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CtxError(
      `Config file is not valid JSON: ${file}\n` +
        `Fix the JSON, or delete the file to let ctx recreate it (your preferences live in the database, not here).`,
    );
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CtxError(
      `Config file has invalid values: ${file}\n` +
        `${parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}\n` +
        `Fix the values, or delete the file to let ctx recreate it.`,
    );
  }
  return parsed.data;
}

export function saveConfig(paths: CtxPaths, config: Config): void {
  ensureHome(paths);
  writeFileAtomic(paths.configFile, JSON.stringify(config, null, 2) + "\n", 0o600);
}
