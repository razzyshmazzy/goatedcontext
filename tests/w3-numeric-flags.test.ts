import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Strict integer flag parsing (Wave 3 §21). `parseInt`-style coercion accepted numeric
 * prefixes ("1e3" → 1, "10foo" → 10), silently corrupting flags. Integer flags now
 * consume the whole argument and reject malformed/out-of-range values.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-numflag-"));
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
  "malformed integer flags are rejected; valid ones are accepted",
  async () => {
    const h = home();
    try {
      await run(["init"], h);
      for (const bad of ["1e3", "1.5", "10foo", "NaN", "Infinity", "0x10", "", "abc"]) {
        const res = await run(["get", "--limit", bad], h);
        expect(res.code).not.toBe(0); // rejected, not silently coerced
        expect(res.stderr.toLowerCase()).toContain("--limit");
      }
      // Valid integers work.
      const ok = await run(["get", "--limit", "5"], h);
      expect(ok.code).toBe(0);
      // Below-range rejected.
      const zero = await run(["get", "--limit", "0"], h);
      expect(zero.code).not.toBe(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "budget flags are strict too (history --limit, context --budget-chars)",
  async () => {
    const h = home();
    try {
      await run(["init"], h);
      expect((await run(["history", "--limit", "2e2"], h)).code).not.toBe(0);
      expect((await run(["history", "--limit", "20"], h)).code).toBe(0);
      expect((await run(["agent", "context", "--budget-chars", "1e3"], h)).code).not.toBe(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);
