import { mkdtempSync, rmSync } from "node:fs";
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
