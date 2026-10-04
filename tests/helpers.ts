import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../src/storage/sqlite/db.ts";
import { FileSecretStore } from "../src/storage/secrets/file-backend.ts";
import { CtxContext } from "../src/core/context.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import type { Config } from "../src/storage/config.ts";

export interface TestEnv {
  ctx: CtxContext;
  dir: string;
  cleanup: () => void;
}

/** Build an isolated CtxContext backed by an in-memory DB and a temp secret dir. */
export function makeTestContext(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "ctx-test-"));
  const paths = resolvePaths({ CTX_HOME: dir });
  const db = openMemoryDatabase();
  const secrets = new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
  const config: Config = {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    retrievalLimit: 12,
  };
  const ctx = CtxContext.fromParts(paths, config, db, secrets);
  return {
    ctx,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a throwaway git repository with a deterministic `origin` remote (so it has
 * a stable `remote:…` identity), returning its root path and a cleanup fn. Used by
 * projection/sync tests that need a real repo to resolve and to write AGENTS.md /
 * .cursor rules into.
 */
export function makeGitRepo(remote = "https://github.com/acme/widgets.git"): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "ctx-repo-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  run(["init", "-q"]);
  run(["remote", "add", "origin", remote]);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
