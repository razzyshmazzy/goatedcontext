import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { CtxPaths } from "./paths.ts";
import { nowIso } from "../utils/time.ts";

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
    const cfg = defaultConfig();
    saveConfig(paths, cfg);
    return cfg;
  }
  const raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
  return ConfigSchema.parse(raw);
}

export function saveConfig(paths: CtxPaths, config: Config): void {
  ensureHome(paths);
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
}
