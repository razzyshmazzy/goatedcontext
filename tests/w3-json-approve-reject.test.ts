import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `prefs approve`/`prefs reject` must honor `--json` (Wave 3 §18): machine JSON only,
 * no prose. The parent `prefs` command also declares `--json`, so the flag can bind to
 * the parent — the subcommands now read it via optsWithGlobals.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-jsonar-"));
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
  "approve --json and reject --json emit machine JSON only (no prose)",
  async () => {
    const h = home();
    try {
      await run(["remember", "Rule one here.", "--scope", "global"], h);
      await run(["remember", "Rule two here.", "--scope", "global"], h);
      const ids = JSON.parse((await run(["prefs", "--json"], h)).stdout).map((p: { id: string }) => p.id);

      const ap = await run(["prefs", "approve", ids[0], "--json"], h);
      expect(ap.code).toBe(0);
      const apObj = JSON.parse(ap.stdout); // must parse as JSON (throws otherwise)
      expect(apObj.id).toBe(ids[0]);
      expect(ap.stdout).not.toMatch(/Approved \(/); // no human prose

      const rj = await run(["prefs", "reject", ids[1], "--json"], h);
      expect(rj.code).toBe(0);
      const rjObj = JSON.parse(rj.stdout);
      expect(rjObj.status).toBe("rejected");
      expect(rj.stdout).not.toMatch(/Rejected \(/);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);
