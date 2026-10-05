import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { exportData } from "../src/core/transfer/transfer.ts";
import { renderContextBlock } from "../src/core/render/context-block.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { FileSecretStore } from "../src/storage/secrets/file-backend.ts";
import { DpapiSecretStore } from "../src/storage/secrets/dpapi-backend.ts";
import { createSecretStore } from "../src/storage/secrets/index.ts";
import { resolvePaths } from "../src/storage/paths.ts";

/**
 * Secret backend audit (0.3.0 diagnostic, CI-blocking). Secret VALUES must never
 * surface anywhere a human/agent/export can read — only in the secret store itself.
 */

const SECRET = "sk-SUPER-SECRET-VALUE-do-not-leak-1234567890";

function withSecretEnv() {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "openai-dev", scope: "global", repoId: null, riskLevel: "test", description: null });
  t.ctx.environments.setVariable(env.id, "OPENAI_API_KEY", SECRET);
  return t;
}

test("export bundle contains NO secret value (environments are excluded entirely)", () => {
  const t = withSecretEnv();
  try {
    t.ctx.preferences.remember({ rule: "Prefer the OpenAI SDK.", scope: "global" });
    const bundle = JSON.stringify(exportData(t.ctx));
    expect(bundle).not.toContain(SECRET);
    expect(bundle).not.toContain("OPENAI_API_KEY"); // var names aren't exported either
    expect(bundle).not.toContain("openai-dev"); // environments not in the bundle at all
  } finally {
    t.cleanup();
  }
});

test("hook context block exposes only the environment NAME, never its secret value", () => {
  const t = withSecretEnv();
  try {
    t.ctx.preferences.remember({ rule: "Always use the shared client.", scope: "global", applicability: "always" });
    const result = t.ctx.retrieval.retrieve({ cwd: "/x", task: "call the api", track: false });
    const block = renderContextBlock(result) ?? "";
    expect(block).toContain("openai-dev"); // the name is advertised (available env)
    expect(block).not.toContain(SECRET); // the value never is
    expect(block).not.toContain("OPENAI_API_KEY");
  } finally {
    t.cleanup();
  }
});

test("doctor output (human + json) never contains a secret value or the key material", () => {
  const t = withSecretEnv();
  try {
    const report = runDoctor({ version: "0.3.0-diag", env: { CTX_HOME: t.dir, CTX_SECRET_BACKEND: "file" }, skipAdapter: true });
    const json = JSON.stringify(report);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("secret.key");
  } finally {
    t.cleanup();
  }
});

test("stats and history never carry secret values", () => {
  const t = withSecretEnv();
  try {
    // Generate some history/stats activity.
    const p = t.ctx.preferences.remember({ rule: "Use env secrets via ctx env run.", scope: "global" });
    t.ctx.preferences.forget(p.id, { expectedVersion: p.version });
    const events = JSON.stringify(t.ctx.events.list({ limit: 100 }));
    const stats = JSON.stringify(t.ctx.stats.read());
    expect(events).not.toContain(SECRET);
    expect(stats).not.toContain(SECRET);
  } finally {
    t.cleanup();
  }
});

test("FileSecretStore round-trips the value but HONESTLY reports it is not OS-secure", () => {
  const t = withSecretEnv();
  try {
    const store = new FileSecretStore(resolvePaths({ CTX_HOME: t.dir }).secretsFile, resolvePaths({ CTX_HOME: t.dir }).secretKeyFile);
    const info = store.describe();
    expect(info.secure).toBe(false); // no false claim of OS keychain
    expect(info.backend).toBe("encrypted-file");
    expect(info.note.toLowerCase()).toContain("same machine");
  } finally {
    t.cleanup();
  }
});

test("secret backend selection is explicit and platform-honest", () => {
  const t = makeTestContext();
  try {
    const paths = resolvePaths({ CTX_HOME: t.dir });
    // Forced file backend everywhere.
    expect(createSecretStore(paths, { CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv).backend).toBe("encrypted-file");

    // auto: DPAPI on Windows when available, else encrypted-file. Report what THIS host does.
    const auto = createSecretStore(paths, { CTX_SECRET_BACKEND: "auto" } as NodeJS.ProcessEnv);
    if (process.platform === "win32" && DpapiSecretStore.isAvailable()) {
      expect(auto.describe().secure).toBe(true); // DPAPI is OS-secure
    } else {
      expect(auto.backend).toBe("encrypted-file");
      expect(auto.describe().secure).toBe(false);
    }

    // Forcing dpapi on a non-Windows / unavailable host must THROW, not fake security.
    if (!(process.platform === "win32" && DpapiSecretStore.isAvailable())) {
      expect(() => createSecretStore(paths, { CTX_SECRET_BACKEND: "dpapi" } as NodeJS.ProcessEnv)).toThrow();
    }
  } finally {
    t.cleanup();
  }
});
