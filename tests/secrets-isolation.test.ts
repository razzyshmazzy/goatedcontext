import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

test("ctx get never exposes secret values", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "test-api" });
  const secret = "sk-top-secret-value-should-never-leak";
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", secret);
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies.",
    category: "dependencies",
    scope: "global",
  });

  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "call the API",
    includeProposed: true,
  });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(secret);
  // The environment is still surfaced by NAME and availability, just not value.
  const apiEnv = result.environments.find((e) => e.name === "test-api");
  expect(apiEnv).toBeDefined();
  expect(apiEnv!.available).toBe(true);
  expect(apiEnv!.variableNames).toContain("OPENAI_API_KEY");
  t.cleanup();
});

test("secret values are not stored in any preference record", () => {
  const t = makeTestContext();
  const secret = "sk-never-in-a-preference";
  const env = t.ctx.environments.add({ name: "test-api" });
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", secret);

  // Even if a user tries to record a preference, the secret store is separate;
  // here we assert no preference row can accidentally contain the secret.
  t.ctx.preferences.remember({
    rule: "Use the shared API client.",
    category: "conventions",
    scope: "global",
  });
  const prefsDump = JSON.stringify(t.ctx.db.query("SELECT * FROM preferences").all());
  const evidenceDump = JSON.stringify(t.ctx.db.query("SELECT * FROM evidence").all());
  expect(prefsDump).not.toContain(secret);
  expect(evidenceDump).not.toContain(secret);
  t.cleanup();
});
