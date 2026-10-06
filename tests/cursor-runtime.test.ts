import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCursorRuntime,
  uninstallCursorRuntime,
  cursorRuntimeStatus,
} from "../src/adapters/cursor/installer.ts";
import {
  cursorHooksFile,
  upsertCursorHook,
  removeCursorHook,
  detectCursorHook,
  CURSOR_HOOK_MARKER,
} from "../src/adapters/cursor/hooks.ts";
import {
  cursorMcpFile,
  upsertCursorMcp,
  CURSOR_MCP_SERVER_NAME,
} from "../src/adapters/cursor/mcp.ts";

// Phase 5 (0.4.0): real Cursor runtime integration — a sessionStart hook + an mcp.json
// server entry, both written with SURGICAL ownership into ~/.cursor. Exercises the §46
// matrix against real files, plus the actual JSON hook protocol via a spawned process.

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-cursor-"));
}
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

test("A. clean install adds the sessionStart hook and the goatedcontext MCP server", () => {
  const h = home();
  try {
    const r = installCursorRuntime({ home: h, platform: "linux" });
    expect(r.hookAction).toBe("created");
    expect(r.mcpAction).toBe("created");

    const hooks = readJson(cursorHooksFile(h));
    expect(hooks.version).toBe(1);
    const entry = hooks.hooks.sessionStart.find((e: { command: string }) => e.command.includes(CURSOR_HOOK_MARKER));
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("command");

    const mcp = readJson(cursorMcpFile(h));
    const srv = mcp.mcpServers[CURSOR_MCP_SERVER_NAME];
    expect(srv.command).toBe("ctx"); // persistent launcher (linux), NOT a repo/npx path
    expect(srv.args).toEqual(["mcp"]);
    expect(JSON.stringify(mcp)).not.toContain("node_modules");
    expect(JSON.stringify(mcp)).not.toContain("_npx");
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("B. unrelated hooks are preserved on install", () => {
  const h = home();
  try {
    mkdirSync(h, { recursive: true });
    writeFileSync(
      cursorHooksFile(h),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: "my-own-script.sh", type: "command" }],
          beforeShellExecution: [{ command: "guard.sh", type: "command" }],
        },
      }),
    );
    installCursorRuntime({ home: h, platform: "linux" });
    const hooks = readJson(cursorHooksFile(h));
    const cmds = hooks.hooks.sessionStart.map((e: { command: string }) => e.command);
    expect(cmds).toContain("my-own-script.sh"); // unrelated sessionStart hook preserved
    expect(cmds.some((c: string) => c.includes(CURSOR_HOOK_MARKER))).toBe(true); // ours added
    expect(hooks.hooks.beforeShellExecution[0].command).toBe("guard.sh"); // unrelated event untouched
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("C. unrelated MCP servers are preserved on install", () => {
  const h = home();
  try {
    mkdirSync(h, { recursive: true });
    writeFileSync(
      cursorMcpFile(h),
      JSON.stringify({ mcpServers: { github: { command: "gh-mcp", args: ["serve"] } } }),
    );
    installCursorRuntime({ home: h, platform: "linux" });
    const mcp = readJson(cursorMcpFile(h));
    expect(mcp.mcpServers.github.command).toBe("gh-mcp"); // unrelated server preserved
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME]).toBeTruthy(); // ours added
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("D. repair restores a missing ctx hook (and is idempotent)", () => {
  const h = home();
  try {
    installCursorRuntime({ home: h, platform: "linux" });
    expect(removeCursorHook(cursorHooksFile(h))).toBe("removed");
    expect(detectCursorHook(cursorHooksFile(h))).toBe(false);
    // Repair == install: converges the hook back.
    const again = installCursorRuntime({ home: h, platform: "linux" });
    expect(again.hookAction).toBe("created");
    expect(detectCursorHook(cursorHooksFile(h))).toBe(true);
    // Idempotent: a second install changes nothing.
    expect(installCursorRuntime({ home: h, platform: "linux" }).hookAction).toBe("unchanged");
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("E. repair converges a STALE ctx MCP entry to the correct invocation", () => {
  const h = home();
  try {
    mkdirSync(h, { recursive: true });
    // A stale ctx entry pointing at an old/ephemeral path.
    upsertCursorMcp(cursorMcpFile(h), "/tmp/_npx/old/ctx", ["mcp"]);
    const r = installCursorRuntime({ home: h, platform: "linux" });
    expect(r.mcpAction).toBe("updated"); // converged, not duplicated
    const mcp = readJson(cursorMcpFile(h));
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME].command).toBe("ctx");
    expect(Object.keys(mcp.mcpServers)).toEqual([CURSOR_MCP_SERVER_NAME]); // single entry, no dup
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("F. uninstall removes ONLY ctx-owned entries", () => {
  const h = home();
  try {
    mkdirSync(h, { recursive: true });
    writeFileSync(
      cursorHooksFile(h),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "keep.sh", type: "command" }] } }),
    );
    writeFileSync(
      cursorMcpFile(h),
      JSON.stringify({ mcpServers: { github: { command: "gh-mcp", args: [] } } }),
    );
    installCursorRuntime({ home: h, platform: "linux" });
    const u = uninstallCursorRuntime({ home: h });
    expect(u.hookAction).toBe("removed");
    expect(u.mcpAction).toBe("removed");

    const hooks = readJson(cursorHooksFile(h));
    expect(hooks.hooks.sessionStart.map((e: { command: string }) => e.command)).toEqual(["keep.sh"]);
    const mcp = readJson(cursorMcpFile(h));
    expect(mcp.mcpServers.github).toBeTruthy(); // unrelated server kept
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME]).toBeUndefined(); // ours gone
    expect(cursorRuntimeStatus({ home: h })).toEqual({ hook: false, mcp: false });
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("G. malformed config is never clobbered (fail safe)", () => {
  const h = home();
  try {
    mkdirSync(h, { recursive: true });
    const badHooks = "{ this is not json ";
    const badMcp = "}}} also broken";
    writeFileSync(cursorHooksFile(h), badHooks);
    writeFileSync(cursorMcpFile(h), badMcp);
    expect(upsertCursorHook(cursorHooksFile(h), "ctx hook cursor-session")).toBe("error");
    expect(upsertCursorMcp(cursorMcpFile(h), "ctx", ["mcp"])).toBe("error");
    // Files are left exactly as they were — never replaced.
    expect(readFileSync(cursorHooksFile(h), "utf8")).toBe(badHooks);
    expect(readFileSync(cursorMcpFile(h), "utf8")).toBe(badMcp);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

// H + I: the actual sessionStart JSON protocol, driven through a spawned `ctx` process.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ctx-cursor-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

test(
  "H. the sessionStart hook returns valid JSON with additional_context (standing rules + MCP instruction)",
  () => {
    const h = home();
    const repo = gitRepo();
    const env = { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" } as Record<string, string>;
    try {
      execFileSync(BUN, ["run", INDEX, "remember", "--always", "Use Bun for everything."], { env });
      const payload = JSON.stringify({ workspace_roots: [repo], session_id: "s1", is_background_agent: false });
      const out = execFileSync(BUN, ["run", INDEX, "hook", "cursor-session"], {
        env,
        input: payload,
        encoding: "utf8",
      });
      const parsed = JSON.parse(out); // MUST be valid JSON (Cursor requires it)
      expect(typeof parsed.additional_context).toBe("string");
      expect(parsed.additional_context).toContain("Use Bun for everything."); // standing rule injected
      expect(parsed.additional_context.toLowerCase()).toContain("get_context"); // MCP instruction present
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "H2. the sessionStart hook fails OPEN (valid JSON) on malformed input — never blocks the session",
  () => {
    const h = home();
    const env = { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" } as Record<string, string>;
    try {
      const out = execFileSync(BUN, ["run", INDEX, "hook", "cursor-session"], {
        env,
        input: "not json",
        encoding: "utf8",
      });
      const parsed = JSON.parse(out);
      expect(parsed).toEqual({}); // fail open: empty, still valid JSON, exit 0
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);
