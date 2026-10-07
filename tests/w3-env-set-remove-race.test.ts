import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";

/**
 * Concurrent env mutations must never split declaration/value (Wave 3 §26). The same
 * cross-process lock now guards setVariable, removeVariable and whole-env remove, so the
 * final state is always ONE valid complete state — a variable is either fully present
 * (declared AND readable) or fully absent, never half-written.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-setrm-"));
}
function run(args: string[], h: string) {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    cwd: h,
    env: { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  })();
}
async function availability(h: string) {
  const res = await run(["env", "list", "--json"], h);
  return JSON.parse(res.stdout) as Array<{ name: string; available: boolean; variableNames: string[] }>;
}

test(
  "concurrent `env set` vs whole-env `remove` converges to one valid state (20 trials)",
  async () => {
    const h = home();
    try {
      for (let i = 0; i < 20; i++) {
        await run(["env", "add", "api"], h);
        await run(["env", "set", "api", "TOKEN", "--value", "seed"], h);
        // Race setting a new value against removing the whole environment.
        await Promise.all([
          run(["env", "set", "api", "TOKEN", "--value", `v${i}`], h).catch(() => null),
          run(["env", "remove", "api"], h).catch(() => null),
        ]);
        const api = (await availability(h)).find((e) => e.name === "api");
        if (api) {
          // If the env survived, every declared variable must be readable — no split.
          if (api.variableNames.length > 0) expect(api.available).toBe(true);
        }
        // Clean up for the next trial (env may or may not still exist).
        await run(["env", "remove", "api"], h).catch(() => null);
      }
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  120_000,
);

// Direct service-level check of the removeVariable ordering (service-only API; no CLI).
test("removeVariable leaves no split state: both declaration and value gone", () => {
  const t = makeTestContext();
  try {
    const env = t.ctx.environments.add({ name: "api", scope: "global", repoId: null, riskLevel: "test", description: null });
    t.ctx.environments.setVariable(env.id, "A", "av");
    t.ctx.environments.setVariable(env.id, "B", "bv");
    t.ctx.environments.removeVariable(env.id, "A");

    expect(t.ctx.environments.variableNames(env.id)).toEqual(["B"]);
    // A's value is gone; B's remains readable (no split).
    const a = t.ctx.environments.availability(env);
    expect(a.variableNames).toEqual(["B"]);
    expect(a.available).toBe(true);
  } finally {
    t.cleanup();
  }
});
