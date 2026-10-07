import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Parallel `env set` atomicity (Wave 2). The declaration (SQLite row) and the value
 * (secret store) are two stores; the old code could leave "declaration present, value
 * gone" when a losing concurrent writer's UNIQUE-violation compensation deleted the
 * winner's secret (~10 failures in 25 trials). A cross-process lock now makes the pair
 * atomic.
 *
 * The invariant is probed with `env list --json`: Wave 1 made `available` HONEST — it
 * is true only when every declared variable's value actually decrypts. So available ===
 * true proves declaration AND value are consistent, without ever printing a secret.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-setrace-"));
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

async function availability(h: string): Promise<Array<{ name: string; available: boolean; variableNames: string[] }>> {
  const res = await run(["env", "list", "--json"], h);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout);
}

test(
  "concurrent env set on the SAME new variable never splits declaration/value (30 trials)",
  async () => {
    const h = home();
    try {
      expect((await run(["env", "add", "api"], h)).code).toBe(0);
      const TRIALS = 30;
      const CONCURRENCY = 4;
      for (let trial = 0; trial < TRIALS; trial++) {
        const varName = `TOKEN_${trial}`;
        // Fire several processes setting the SAME new variable at once.
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, i) =>
            run(["env", "set", "api", varName, "--value", `value-${trial}-${i}`], h),
          ),
        );
        // Every writer that reported success must have produced a consistent pair.
        expect(results.every((r) => r.code === 0)).toBe(true);
      }
      // After all trials, EVERY declared variable must have a readable value.
      const list = await availability(h);
      const api = list.find((e) => e.name === "api")!;
      expect(api.variableNames.length).toBe(TRIALS); // one row per trial, no duplicates
      expect(api.available).toBe(true); // declaration + value consistent for all
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  120_000,
);

test(
  "concurrent env set on DIFFERENT variables all survive",
  async () => {
    const h = home();
    try {
      expect((await run(["env", "add", "api"], h)).code).toBe(0);
      const N = 12;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          run(["env", "set", "api", `VAR_${i}`, "--value", `v${i}`], h),
        ),
      );
      expect(results.every((r) => r.code === 0)).toBe(true);
      const list = await availability(h);
      const api = list.find((e) => e.name === "api")!;
      expect(api.variableNames.length).toBe(N); // all distinct vars present
      expect(api.available).toBe(true); // all values readable
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  120_000,
);
