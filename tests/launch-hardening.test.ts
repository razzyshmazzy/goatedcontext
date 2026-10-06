import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { loadConfig, ensureHome } from "../src/storage/config.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { CtxContext } from "../src/core/context.ts";
import { FileSecretStore } from "../src/storage/secrets/file-backend.ts";
import { envVarSecretRef } from "../src/storage/secrets/types.ts";
import { CtxError } from "../src/utils/errors.ts";

/**
 * Regression tests for the 0.3.6 launch-hardening audit fixes:
 *  - a corrupt config.json yields an actionable error, not a raw SyntaxError;
 *  - CtxContext.open fails cleanly (no leaked DB handle) when config load throws;
 *  - the file secret store uses ONE consistent key across writes;
 *  - setVariable compensates (deletes the secret) if its DB row insert fails, so no
 *    encrypted material is stranded without a referencing row.
 */

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-harden-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("corrupt config.json fails with an actionable CtxError, not a raw SyntaxError", () => {
  const s = scratch();
  try {
    const paths = resolvePaths({ CTX_HOME: s.dir });
    ensureHome(paths);
    writeFileSync(paths.configFile, "{ not valid json ");
    let err: unknown;
    try {
      loadConfig(paths);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CtxError);
    expect((err as Error).message).toContain("not valid JSON");
    expect((err as Error).message).toContain(paths.configFile);
  } finally {
    s.cleanup();
  }
});

test("config.json with out-of-range values reports the exact invalid field", () => {
  const s = scratch();
  try {
    const paths = resolvePaths({ CTX_HOME: s.dir });
    ensureHome(paths);
    writeFileSync(paths.configFile, JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", retrievalLimit: 999 }));
    let err: unknown;
    try {
      loadConfig(paths);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CtxError);
    expect((err as Error).message).toContain("invalid values");
    expect((err as Error).message).toContain("retrievalLimit");
  } finally {
    s.cleanup();
  }
});

test("CtxContext.open fails cleanly on a corrupt config and the db is usable afterward", () => {
  const s = scratch();
  try {
    const env = { CTX_HOME: s.dir, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
    const paths = resolvePaths(env);
    ensureHome(paths);
    writeFileSync(paths.configFile, "{ broken");
    // open() opens the DB before loadConfig throws; the fix must close the handle so
    // the file is not left locked/half-open. We assert a clear error AND that a
    // subsequent open (after removing the bad config) succeeds against the same files.
    expect(() => CtxContext.open(env)).toThrow(CtxError);
    rmSync(paths.configFile, { force: true });
    const ctx = CtxContext.open(env);
    expect(ctx.config.retrievalLimit).toBe(12);
    ctx.close();
  } finally {
    s.cleanup();
  }
});

test("file secret store uses one consistent key across writes (round-trips via a second instance)", () => {
  const s = scratch();
  try {
    const paths = resolvePaths({ CTX_HOME: s.dir });
    ensureHome(paths);
    const writer = new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
    writer.set("ref-a", "value-a");
    writer.set("ref-b", "value-b");
    // A separate instance (a stand-in for another process) must decrypt BOTH — proof
    // that a single key was used, not a per-write key that would strand one entry.
    const reader = new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
    expect(reader.get("ref-a")).toBe("value-a");
    expect(reader.get("ref-b")).toBe("value-b");
  } finally {
    s.cleanup();
  }
});

test("setVariable compensates by deleting the secret if the DB row insert fails", () => {
  const t = makeTestContext();
  // A non-existent environment id: the existence SELECT returns nothing (so the secret
  // IS written), then the INSERT fails the environment_variables→environments foreign
  // key (enforcement is ON). Without compensation the secret would be stranded.
  const envId = "env-does-not-exist";
  const ref = envVarSecretRef(envId, "API_KEY");
  try {
    expect(() => t.ctx.environments.setVariable(envId, "API_KEY", "s3cr3t")).toThrow();
    const store = new FileSecretStore(t.ctx.paths.secretsFile, t.ctx.paths.secretKeyFile);
    expect(store.has(ref)).toBe(false); // compensating delete removed the orphan
  } finally {
    t.cleanup();
  }
});
