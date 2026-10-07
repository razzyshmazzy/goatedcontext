import { test, expect } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolvePaths } from "../src/storage/paths.ts";
import { makeTestContext } from "./helpers.ts";

/**
 * `env list` availability must be HONEST (security wave): when key material is missing
 * or a value no longer decrypts, the environment must report available=false — never
 * claim a value is injectable when it is not. Ciphertext is never exposed.
 */

test("availability is true only while every value is actually readable", () => {
  const t = makeTestContext();
  try {
    const env = t.ctx.environments.add({ name: "api", scope: "global", repoId: null, riskLevel: "test", description: null });
    t.ctx.environments.setVariable(env.id, "TOKEN", "sk-real-value");
    expect(t.ctx.environments.availability(env).available).toBe(true);

    // Key disappears but ciphertext remains: the value is no longer injectable.
    unlinkSync(resolvePaths({ CTX_HOME: t.dir }).secretKeyFile);
    expect(t.ctx.environments.availability(env).available).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("availability is false (not a crash) on a corrupt secrets store", () => {
  const t = makeTestContext();
  try {
    const env = t.ctx.environments.add({ name: "api", scope: "global", repoId: null, riskLevel: "test", description: null });
    t.ctx.environments.setVariable(env.id, "TOKEN", "sk-real-value");
    writeFileSync(resolvePaths({ CTX_HOME: t.dir }).secretsFile, "{ corrupt <<SENTINEL>>");
    const a = t.ctx.environments.availability(env);
    expect(a.available).toBe(false);
    expect(a.variableNames).toEqual(["TOKEN"]); // names still listed; value never exposed
  } finally {
    t.cleanup();
  }
});
