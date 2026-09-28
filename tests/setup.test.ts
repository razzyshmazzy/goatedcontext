import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, renderSetup, type SetupOptions } from "../src/cli/setup.ts";
import { detectPromptHook, getPromptHookCommand } from "../src/adapters/claude/hook.ts";

// `runSetup` is pure orchestration, so every system-touching seam (npm global
// install, PATH resolution, fresh-process verification) is injected here. That
// lets these tests exercise the real init + real Claude adapter wiring against
// temp dirs without ever mutating the machine's global npm or PATH.

const LAUNCHER = process.platform === "win32" ? "ctx.cmd" : "ctx";

interface Harness {
  ctxHome: string;
  claudeHome: string;
  binDir: string;
  cleanup: () => void;
}

function harness(): Harness {
  const ctxHome = mkdtempSync(join(tmpdir(), "ctx-setup-home-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "ctx-setup-claude-"));
  const binDir = mkdtempSync(join(tmpdir(), "ctx-setup-bin-"));
  return {
    ctxHome,
    claudeHome,
    binDir,
    cleanup: () => {
      for (const d of [ctxHome, claudeHome, binDir]) rmSync(d, { recursive: true, force: true });
    },
  };
}

function baseOptions(h: Harness, overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    env: { CTX_HOME: h.ctxHome, CTX_SECRET_BACKEND: "file", PATH: "" },
    version: "9.9.9",
    claudeHome: h.claudeHome,
    globalBinDir: h.binDir,
    packageRoot: "/fake/package/root",
    // Default seams: nothing on PATH, install succeeds by creating the launcher,
    // verification succeeds and reports the current version.
    which: () => null,
    installGlobal: (root: string) => {
      writeFileSync(join(h.binDir, LAUNCHER), `echo ${root}`, "utf8");
      return { ok: true, detail: "" };
    },
    verify: () => ({ ok: true, version: "9.9.9" }),
    ...overrides,
  };
}

test("a fresh machine gets a global install and a wired-up Claude hook", () => {
  const h = harness();
  try {
    const result = runSetup(baseOptions(h));

    expect(result.globalInstall).toBe("installed");
    expect(result.skills.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);

    // The Claude adapter was really installed into the temp claude home.
    const settings = join(h.claudeHome, "settings.json");
    expect(detectPromptHook(settings)).toBe(true);
    expect(getPromptHookCommand(settings)).toBe(result.hookCommand);

    // Not on PATH → the hook uses the absolute launcher path so Claude can find it.
    expect(result.hookCommand).toContain(h.binDir);
    expect(result.hookCommand).toContain("hook claude-prompt");
    // ...and the user is told exactly how to fix PATH.
    expect(result.warnings.join("\n")).toContain("PATH");
  } finally {
    h.cleanup();
  }
});

test("re-running is idempotent: an up-to-date global install is not reinstalled", () => {
  const h = harness();
  try {
    // Pre-create a launcher (already globally installed) and put it on PATH.
    writeFileSync(join(h.binDir, LAUNCHER), "echo ctx", "utf8");
    let installs = 0;

    const result = runSetup(
      baseOptions(h, {
        which: () => join(h.binDir, LAUNCHER), // ctx resolves on PATH
        installGlobal: () => {
          installs++;
          return { ok: true, detail: "" };
        },
        verify: () => ({ ok: true, version: "9.9.9" }), // same as opts.version
      }),
    );

    expect(installs).toBe(0); // no reinstall
    expect(result.globalInstall).toBe("present");
    expect(result.ctxResolvesOnPath).toBe(true);
    // On PATH → the proven PATH-based hook command is used.
    expect(result.hookCommand).toBe("ctx hook claude-prompt");
    expect(result.warnings).toHaveLength(0);
    expect(result.ok).toBe(true);
  } finally {
    h.cleanup();
  }
});

test("an out-of-date global install triggers an upgrade", () => {
  const h = harness();
  try {
    writeFileSync(join(h.binDir, LAUNCHER), "echo ctx", "utf8");
    let installs = 0;

    const result = runSetup(
      baseOptions(h, {
        which: () => join(h.binDir, LAUNCHER),
        installGlobal: () => {
          installs++;
          return { ok: true, detail: "" };
        },
        verify: () => ({ ok: true, version: "0.0.1" }), // older than opts.version 9.9.9
      }),
    );

    expect(installs).toBe(1);
    expect(result.globalInstall).toBe("upgraded");
    expect(result.ok).toBe(true);
  } finally {
    h.cleanup();
  }
});

test("--skip-global initializes and wires Claude without touching npm", () => {
  const h = harness();
  try {
    let installs = 0;
    const result = runSetup(
      baseOptions(h, {
        skipGlobalInstall: true,
        installGlobal: () => {
          installs++;
          return { ok: true, detail: "" };
        },
      }),
    );

    expect(installs).toBe(0);
    expect(result.globalInstall).toBe("skipped");
    expect(detectPromptHook(join(h.claudeHome, "settings.json"))).toBe(true);
    expect(result.ok).toBe(true);
  } finally {
    h.cleanup();
  }
});

test("a failed global install is reported and marks setup not-ok", () => {
  const h = harness();
  try {
    const result = runSetup(
      baseOptions(h, {
        installGlobal: () => ({ ok: false, detail: "npm exploded" }),
        verify: () => ({ ok: false, version: null }),
      }),
    );

    expect(result.globalInstall).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.warnings.join("\n")).toContain("npm exploded");
  } finally {
    h.cleanup();
  }
});

test("renderSetup prints the short success summary", () => {
  const h = harness();
  try {
    const result = runSetup(
      baseOptions(h, {
        which: () => join(h.binDir, LAUNCHER),
        installGlobal: () => {
          writeFileSync(join(h.binDir, LAUNCHER), "echo ctx", "utf8");
          return { ok: true, detail: "" };
        },
      }),
    );
    const text = renderSetup(result).join("\n");
    expect(text).toContain("goatedcontext");
    expect(text).toContain("initialized local context");
    expect(text).toContain("installed proactive retrieval hook");
    expect(text).toContain("secrets:");
    if (result.ok && result.warnings.length === 0) expect(text).toContain("goat acquired.");
  } finally {
    h.cleanup();
  }
});
