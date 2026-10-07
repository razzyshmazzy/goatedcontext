import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcp } from "./support/mcp-client.ts";

/**
 * MCP shutdown lifecycle (Wave 2). `StdioServerTransport` never reacts to stdin EOF, so
 * a client disconnect used to leave the server's top-level await unsettled → Node
 * "Detected unsettled top-level await" warning + exit 13. The server now treats stdin
 * end/close as a clean disconnect and exits 0 promptly.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TLA = "unsettled top-level await";

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-mcpshut-"));
}

test(
  "closing stdin immediately → server exits 0 with no unsettled-top-level-await warning",
  async () => {
    const h = home();
    try {
      const proc = Bun.spawn([BUN, "run", INDEX, "mcp"], {
        env: { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.end(); // immediate EOF — the clean-disconnect path
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      expect(code).toBe(0); // clean exit, not 13
      expect(stderr).not.toContain(TLA);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "10 clean open/initialize/list/close cycles each shut down promptly, no TLA warning",
  async () => {
    const h = home();
    try {
      for (let i = 0; i < 10; i++) {
        const client = await connectMcp({
          command: BUN,
          args: ["run", INDEX, "mcp"],
          env: { ...(process.env as Record<string, string>), CTX_HOME: h, CTX_SECRET_BACKEND: "file" },
          name: "shutdown-client",
        });
        // Capture the server's stderr for this cycle.
        const transport = (client as unknown as { transport?: { stderr?: NodeJS.ReadableStream } }).transport;
        let stderr = "";
        transport?.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);

        // Closing the client ends the server's stdin. The SDK waits up to 2s before a
        // SIGTERM fallback; a clean EOF-driven exit returns well under that.
        const t0 = performance.now();
        await client.close();
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeLessThan(1500); // exited on its own, not via the 2s SIGTERM fallback
        expect(stderr).not.toContain(TLA);
      }
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  120_000,
);
