import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectMcp, toolJson } from "./support/mcp-client.ts";

/**
 * MCP protocol robustness (Wave 3 §25). We rely on the official SDK for JSON-RPC
 * correctness and do NOT hand-roll stricter rules. These confirm the standard cases
 * behave per spec: an unknown tool errors, malformed tool arguments error, a tool-call
 * error is in-band, and the server stays alive across all of them.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function connect(home: string): Promise<Client> {
  return connectMcp({
    command: BUN,
    args: ["run", INDEX, "mcp"],
    env: { ...(process.env as Record<string, string>), CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    name: "w3-mcp-client",
  });
}

test(
  "unknown tool and malformed args error cleanly; the server stays alive",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-w3mcp-"));
    const client = await connect(home);
    try {
      // Unknown tool → the SDK returns an in-band error result (-32602), not a crash.
      const unknown = (await client.callTool({ name: "does_not_exist", arguments: {} })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(unknown.isError).toBe(true);
      expect(unknown.content?.[0]?.text ?? "").toMatch(/not found/i);

      // Malformed arguments for a real tool (task must be a string) → in-band error.
      const bad = (await client.callTool({
        name: "get_context",
        arguments: { task: 12345 } as unknown as Record<string, unknown>,
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      expect(bad.isError).toBe(true);
      expect(bad.content?.[0]?.text ?? "").toMatch(/validation|invalid/i);

      // The server is still alive and serving after those errors.
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "get_context")).toBe(true);

      // A valid call still works and returns the stable envelope.
      const res = await client.callTool({ name: "get_context", arguments: { task: "build a feature" } });
      const env = toolJson(res);
      expect(env.version).toBe(1);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "a provenance-refused write is an in-band tool error (isError), server stays alive",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-w3mcp2-"));
    const client = await connect(home);
    try {
      // origin must be 'user' for a durable preference; 'external' is refused in-band.
      const res = await client.callTool({
        name: "remember",
        arguments: { rule: "Use Bun.", origin: "external", scope: "global" },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      // Server still alive.
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
  60_000,
);
