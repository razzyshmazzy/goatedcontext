import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";
import { makeTestContext } from "./helpers.ts";
import { InvalidSecretValueError } from "../src/storage/secrets/types.ts";

/**
 * Secret plaintext must NEVER reach a subprocess env in a form that makes the runtime
 * throw an error echoing the value (Node's ERR_INVALID_ARG_VALUE prints env values).
 *
 *  - set-time: a NUL value is rejected before persistence (service boundary).
 *  - run-time: a *legacy* NUL value (stored before validation existed) is rejected
 *    before spawn, and any residual spawn error is redacted — so the literal never
 *    appears on stdout/stderr/error text.
 */

const dist = join(import.meta.dir, "..", "dist", "index.js");
const node = whichSync("node");
const canRunCli = Boolean(node && existsSync(dist));

test("setVariable rejects a NUL value and never echoes it", () => {
  const t = makeTestContext();
  try {
    const env = t.ctx.environments.add({ name: "api", scope: "global", repoId: null, riskLevel: "test", description: null });
    let msg = "";
    try {
      t.ctx.environments.setVariable(env.id, "TOKEN", "sk-NUL\0LEAK");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSecretValueError);
      msg = (e as Error).message;
    }
    expect(msg).toContain("TOKEN"); // names the variable
    expect(msg).not.toContain("sk-NUL"); // never the value
    expect(msg).not.toContain("LEAK");
    // Nothing was persisted for TOKEN.
    expect(t.ctx.environments.variableNames(env.id)).not.toContain("TOKEN");
  } finally {
    t.cleanup();
  }
});

test("env run with a legacy NUL secret fails WITHOUT leaking the plaintext", () => {
  if (!canRunCli) { console.warn("[env-run-leak] skipped: build dist first."); return; }
  const SECRET = "sk-LEAKY-LEGACY-VALUE";
  const LEGACY = `${SECRET}\0tail`; // a NUL-bearing value a pre-validation ctx could have stored
  const home = mkdtempSync(join(tmpdir(), "ctx-leak-"));
  try {
    const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" };
    const cli = (args: string[], extra: Record<string, string> = {}) =>
      spawnSync(node!, [dist, ...args], { encoding: "utf8", env: { ...env, ...extra } });

    expect(cli(["init"]).status).toBe(0);
    expect(cli(["env", "add", "api"]).status).toBe(0);
    // Seed a normal value so the DB metadata row + secret_ref + on-disk key all exist.
    expect(cli(["env", "set", "api", "TOKEN", "--value", "placeholder"]).status).toBe(0);

    // Now forge a LEGACY entry: re-encrypt a NUL-bearing plaintext under the real key,
    // exactly mimicking data a pre-validation ctx could have written to disk.
    const secretsFile = join(home, "secrets", "secrets.json");
    const keyFile = join(home, "secrets", "secret.key");
    const key = readFileSync(keyFile);
    const store = JSON.parse(readFileSync(secretsFile, "utf8")) as Record<string, { iv: string; tag: string; data: string }>;
    const ref = Object.keys(store)[0]!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(LEGACY, "utf8"), cipher.final()]);
    store[ref] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    writeFileSync(secretsFile, JSON.stringify(store, null, 2) + "\n");

    // Run a child that would print its env if it ever started.
    const res = cli(["env", "run", "api", "--exec", "node", "-e", "console.log(process.env.TOKEN)"]);
    const combined = `${res.stdout}\n${res.stderr}\n${res.error?.message ?? ""}`;

    expect(res.status === 0 ? "" : "nonzero").toBe("nonzero"); // failed closed
    expect(combined).not.toContain(SECRET); // the literal never surfaces anywhere
    expect(combined.includes("\0")).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
