import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves the ctx home directory and the paths of the files inside it.
 *
 * The home directory defaults to `~/.ctx` but can be overridden with the
 * `CTX_HOME` environment variable. Tests rely on this override to run against
 * a throwaway directory instead of the developer's real profile.
 */
export interface CtxPaths {
  home: string;
  dbFile: string;
  configFile: string;
  /** Directory holding the encrypted secret store and its key. Never in SQLite. */
  secretsDir: string;
  secretsFile: string;
  secretKeyFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): CtxPaths {
  const home = env.CTX_HOME && env.CTX_HOME.trim().length > 0
    ? env.CTX_HOME
    : join(homedir(), ".ctx");
  const secretsDir = join(home, "secrets");
  return {
    home,
    dbFile: join(home, "ctx.db"),
    configFile: join(home, "config.json"),
    secretsDir,
    secretsFile: join(secretsDir, "secrets.json"),
    secretKeyFile: join(secretsDir, "secret.key"),
  };
}
