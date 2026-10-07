import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Multiline secret stdin (Wave 2). Piping a secret used to truncate at the first
 * newline (readline-once), breaking PEM keys / certs / JSON blobs. Piped input is now
 * read to EOF; embedded newlines are preserved and exactly one trailing newline (the
 * shell artifact) is stripped. The value stays encrypted at rest, is never logged, and
 * survives `env run`.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

// A FAKE key fixture (not a real private key) with several embedded newlines.
const PEM = [
  "-----BEGIN FAKE TEST KEY-----",
  "MIILINE1aaaaaaaaaaaaaaaaaaaaaaaa",
  "LINE2bbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "LINE3ccccccccccccccccccccccccc==",
  "-----END FAKE TEST KEY-----",
].join("\n");

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-multiline-"));
}
function run(args: string[], h: string, stdin?: string) {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    cwd: h,
    env: { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" },
    stdin: stdin != null ? Buffer.from(stdin, "utf8") : undefined,
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
  "piped multiline PEM is stored whole, encrypted, never logged, and survives env run",
  async () => {
    const h = home();
    try {
      expect((await run(["env", "add", "certs"], h)).code).toBe(0);

      // Pipe the PEM with a trailing newline, as `cat key.pem |` would.
      const setRes = await run(["env", "set", "certs", "KEY"], h, PEM + "\n");
      expect(setRes.code).toBe(0);
      // The secret value must never appear in stdout/stderr.
      expect(setRes.stdout + setRes.stderr).not.toContain("LINE2bbbb");
      expect(setRes.stdout + setRes.stderr).not.toContain("BEGIN FAKE TEST KEY");

      // Encrypted at rest: the plaintext must not be in the on-disk store.
      const store = readFileSync(join(h, "secrets", "secrets.json"), "utf8");
      expect(store).not.toContain("LINE2bbbb");
      expect(store).not.toContain("BEGIN FAKE TEST KEY");

      // Round-trip through env run: a child writes the injected value to a file.
      const out = join(h, "readback.txt");
      const script = `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.KEY ?? '');`;
      const runRes = await run(["env", "run", "certs", "--", "node", "-e", script], h);
      expect(runRes.code).toBe(0);
      expect(existsSync(out)).toBe(true);

      // Exactly the fixture: all newlines preserved, the single trailing newline stripped.
      expect(readFileSync(out, "utf8")).toBe(PEM);
      // And the plaintext never leaked via the run command's own output.
      expect(runRes.stdout + runRes.stderr).not.toContain("LINE2bbbb");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "printf 'line1\\nline2' (no trailing newline) stores the exact two-line value",
  async () => {
    const h = home();
    try {
      expect((await run(["env", "add", "e"], h)).code).toBe(0);
      expect((await run(["env", "set", "e", "V"], h, "line1\nline2")).code).toBe(0);
      const out = join(h, "rb.txt");
      const script = `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.V ?? '');`;
      expect((await run(["env", "run", "e", "--", "node", "-e", script], h)).code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("line1\nline2"); // nothing stripped, both lines
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);
