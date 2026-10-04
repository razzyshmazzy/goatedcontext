import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodex, repairCodex, uninstallCodex } from "../src/adapters/codex/installer.ts";
import { detectCodexHook, CODEX_HOOK_MARKER } from "../src/adapters/codex/hook.ts";

// The Codex adapter owns ONLY its UserPromptSubmit hook in ~/.codex/hooks.json.
// (Repo rules come from the shared AGENTS.md written by `ctx sync`; global rules are
// runtime. No global ~/.codex/AGENTS.md is written — that was the 0.2.9 correction.)

function codexDir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-codex-"));
}

test("install writes a UserPromptSubmit hook and writes NO global AGENTS.md", () => {
  const home = codexDir();
  try {
    const r = installCodex({ home });
    expect(r.hookAction).toBe("created");
    const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain(CODEX_HOOK_MARKER);
    expect(detectCodexHook(join(home, "hooks.json"))).toBe(true);
    // Corrected policy: no global AGENTS.md materialization.
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install/repair is idempotent and preserves unrelated hooks.json entries", () => {
  const home = codexDir();
  try {
    writeFileSync(
      join(home, "hooks.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool run" }] }] } }),
    );
    installCodex({ home });
    expect(repairCodex({ home }).hookAction).toBe("unchanged"); // repair converges, no churn

    const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
    const cmds = hooks.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain("other-tool run");
    expect(cmds.filter((c: string) => c.includes(CODEX_HOOK_MARKER))).toHaveLength(1); // no dupe
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--disable-hook removes the hook", () => {
  const home = codexDir();
  try {
    installCodex({ home });
    expect(detectCodexHook(join(home, "hooks.json"))).toBe(true);
    const r = installCodex({ home, disableHook: true });
    expect(r.hookAction).toBe("removed");
    expect(detectCodexHook(join(home, "hooks.json"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall removes our hook, preserving unrelated hooks", () => {
  const home = codexDir();
  try {
    writeFileSync(
      join(home, "hooks.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool run" }] }] } }),
    );
    installCodex({ home });
    const r = uninstallCodex({ home });
    expect(r.hookAction).toBe("removed");
    expect(detectCodexHook(join(home, "hooks.json"))).toBe(false);
    const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
    const cmds = hooks.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain("other-tool run");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("malformed hooks.json is left untouched and reported, not clobbered", () => {
  const home = codexDir();
  try {
    writeFileSync(join(home, "hooks.json"), "{ not valid json");
    const r = installCodex({ home });
    expect(r.hookAction).toBe("error");
    expect(readFileSync(join(home, "hooks.json"), "utf8")).toBe("{ not valid json"); // untouched
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CODEX_HOME env overrides the home dir", () => {
  const home = codexDir();
  try {
    const r = installCodex({ env: { ...process.env, CODEX_HOME: home } });
    expect(r.home).toBe(home);
    expect(detectCodexHook(join(home, "hooks.json"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
