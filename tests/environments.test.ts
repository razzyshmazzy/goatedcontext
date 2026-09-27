import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { makeTestContext } from "./helpers.ts";

test("environment metadata is created and listed", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "test-api", riskLevel: "test" });
  expect(env.name).toBe("test-api");
  expect(env.scope).toBe("global");
  expect(env.riskLevel).toBe("test");
  const list = t.ctx.environments.listApplicable(null);
  expect(list.map((e) => e.environment.name)).toContain("test-api");
  t.cleanup();
});

test("an environment with no secrets set is not available", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "empty" });
  const [avail] = t.ctx.environments.listApplicable(null);
  expect(avail!.environment.id).toBe(env.id);
  expect(avail!.available).toBe(false);
  t.cleanup();
});

test("setVariable stores only names + refs in SQLite, never the value", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "test-api" });
  const secret = "sk-do-not-store-in-sqlite-123";
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", secret);

  const rows = t.ctx.db
    .query<{ var_name: string; secret_ref: string }, [string]>(
      "SELECT var_name, secret_ref FROM environment_variables WHERE environment_id = ?",
    )
    .all(env.id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.var_name).toBe("OPENAI_API_KEY");
  expect(rows[0]!.secret_ref).not.toContain(secret);

  // Dump the entire DB file surface and confirm the secret is absent.
  const dump = JSON.stringify(
    t.ctx.db.query("SELECT * FROM environment_variables").all(),
  );
  expect(dump).not.toContain(secret);
  t.cleanup();
});

test("secrets are encrypted at rest (plaintext not present in secrets.json)", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "test-api" });
  const secret = "sk-plaintext-should-not-appear";
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", secret);
  const onDisk = readFileSync(t.ctx.paths.secretsFile, "utf8");
  expect(onDisk).not.toContain(secret);
  // But it round-trips back through the store.
  expect(t.ctx.secrets.get(`env:${env.id}:OPENAI_API_KEY`)).toBe(secret);
  t.cleanup();
});

test("environment becomes available once its secret is set", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "test-api" });
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", "sk-123");
  const [avail] = t.ctx.environments.listApplicable(null);
  expect(avail!.available).toBe(true);
  expect(avail!.variableNames).toEqual(["OPENAI_API_KEY"]);
  t.cleanup();
});

test("resolveVariables composes multiple environments (later wins)", () => {
  const t = makeTestContext();
  const a = t.ctx.environments.add({ name: "base" });
  const b = t.ctx.environments.add({ name: "override" });
  t.ctx.environments.setVariable(a.id, "TOKEN", "from-a");
  t.ctx.environments.setVariable(a.id, "SHARED", "a-shared");
  t.ctx.environments.setVariable(b.id, "SHARED", "b-shared");
  const merged = t.ctx.environments.resolveVariables([a, b]);
  expect(merged.TOKEN).toBe("from-a");
  expect(merged.SHARED).toBe("b-shared");
  t.cleanup();
});

test("removing an environment deletes its secrets", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "test-api" });
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", "sk-123");
  const ref = `env:${env.id}:OPENAI_API_KEY`;
  expect(t.ctx.secrets.has(ref)).toBe(true);
  t.ctx.environments.remove(env);
  expect(t.ctx.secrets.has(ref)).toBe(false);
  expect(t.ctx.environments.findByName("test-api", null)).toBeNull();
  t.cleanup();
});

test("resolveVariables throws when a declared secret is missing", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "test-api" });
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", "sk-123");
  // Simulate a missing secret by deleting it out from under the metadata.
  t.ctx.secrets.delete(`env:${env.id}:OPENAI_API_KEY`);
  expect(() => t.ctx.environments.resolveVariables([env])).toThrow();
  t.cleanup();
});
