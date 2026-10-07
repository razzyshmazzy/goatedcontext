import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Duplicate-remember idempotency survives CONCURRENT identical writes (Wave 3 §20).
 * Each `remember` runs inside a BEGIN IMMEDIATE transaction, so concurrent identical
 * remembers serialize and the later ones observe the first's committed row — producing
 * exactly ONE preference, never duplicates.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-dedup-"));
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

test(
  "12 concurrent identical remembers create exactly one preference",
  async () => {
    const h = home();
    try {
      await run(["init"], h); // set up the DB first so round is pure contention
      const results = await Promise.all(
        Array.from({ length: 12 }, () => run(["remember", "Use Bun for development."], h)),
      );
      expect(results.every((r) => r.code === 0)).toBe(true);

      const listed = await run(["prefs", "--json"], h);
      expect(listed.code).toBe(0);
      const prefs = JSON.parse(listed.stdout) as Array<{ rule: string }>;
      const matches = prefs.filter((p) => /use bun for development/i.test(p.rule));
      expect(matches.length).toBe(1); // exactly one row, no duplicates
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);
