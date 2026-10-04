import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { installCodex, repairCodex, uninstallCodex } from "../src/adapters/codex/installer.ts";
import { codexConfigFile, codexWritableRootConfigured } from "../src/adapters/codex/config.ts";
import { detectCodexHook } from "../src/adapters/codex/hook.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { agentStatuses } from "../src/core/agents/registry.ts";

function homes() {
  const codexHome = mkdtempSync(join(tmpdir(), "ctx-wr-codex-"));
  const ctxHome = mkdtempSync(join(tmpdir(), "ctx-wr-store-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "ctx-wr-claude-"));
  return { codexHome, ctxHome, claudeHome };
}
function cleanup(...dirs: string[]) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ── installer: writable root converged ────────────────────────────────────────

test("install codex grants ONLY the effective ctx home as a writable root (least privilege)", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
    const r = installCodex({ home: codexHome, env });
    expect(["created", "added"]).toContain(r.writableRootAction);
    expect(r.ctxHome).toBe(ctxHome);
    const cfg = readFileSync(codexConfigFile(codexHome), "utf8");
    // Exactly the ctx home — never a broader dir (home, AppData, drive, repo parent).
    expect(codexWritableRootConfigured(codexConfigFile(codexHome), ctxHome)).toBe(true);
    expect(cfg).toContain("[sandbox_workspace_write]");
    // We never force the sandbox mode (that would change the user's security posture).
    expect(cfg).not.toContain("sandbox_mode");
    // Re-running converges with no further change.
    expect(installCodex({ home: codexHome, env }).writableRootAction).toBe("present");
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

// ── §22 repair: healthy hook + healthy skill + MISSING writable root ──────────

test("repair codex adds a missing writable root; leaves hook, skill & unrelated config intact", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    const hooksBefore = readFileSync(join(codexHome, "hooks.json"), "utf8");
    const skillBefore = readFileSync(join(codexHome, "skills", "goatedcontext", "SKILL.md"), "utf8");

    // Simulate a config that lost the ctx root but has unrelated user settings.
    writeFileSync(
      codexConfigFile(codexHome),
      `model = "gpt-5"\n\n[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = ["/srv/shared"]\n`,
    );
    expect(codexWritableRootConfigured(codexConfigFile(codexHome), ctxHome)).toBe(false);

    const r = repairCodex({ home: codexHome, env });
    expect(r.writableRootAction).toBe("added");
    expect(r.hookAction).toBe("unchanged");
    expect(r.skillAction).toBe("unchanged");

    const cfg = readFileSync(codexConfigFile(codexHome), "utf8");
    expect(codexWritableRootConfigured(codexConfigFile(codexHome), ctxHome)).toBe(true);
    expect(cfg).toContain('model = "gpt-5"'); // unrelated preserved
    expect(cfg).toContain("network_access = true");
    expect(cfg).toContain("/srv/shared"); // existing root preserved
    // Hook + skill untouched.
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toBe(hooksBefore);
    expect(readFileSync(join(codexHome, "skills", "goatedcontext", "SKILL.md"), "utf8")).toBe(skillBefore);
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

test("repair codex fixes a STALE skill and a MISSING root in the same pass", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    // Corrupt the skill and drop the root.
    writeFileSync(join(codexHome, "skills", "goatedcontext", "SKILL.md"), "stale body\n");
    writeFileSync(codexConfigFile(codexHome), `[sandbox_workspace_write]\nnetwork_access = false\n`);

    const r = repairCodex({ home: codexHome, env });
    expect(r.skillAction).toBe("updated");
    expect(r.writableRootAction).toBe("added");
    expect(codexWritableRootConfigured(codexConfigFile(codexHome), ctxHome)).toBe(true);
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

test("uninstall codex leaves the writable root in place (conservative ownership)", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    const cfgBefore = readFileSync(codexConfigFile(codexHome), "utf8");
    const u = uninstallCodex({ home: codexHome, env });
    expect(u.hookAction).toBe("removed");
    expect(u.skillAction).toBe("removed");
    // Config.toml is intentionally untouched by uninstall.
    expect(readFileSync(codexConfigFile(codexHome), "utf8")).toBe(cfgBefore);
    expect(detectCodexHook(join(codexHome, "hooks.json"))).toBe(false);
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

// ── §17 agents surface ────────────────────────────────────────────────────────

test("ctx agents JSON exposes writableRootConfigured for Codex (and null for others)", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    const statuses = agentStatuses({ env, codexHome, claudeHome });
    const codex = statuses.find((s) => s.id === "codex")!;
    const claude = statuses.find((s) => s.id === "claude")!;
    expect(codex.writableRootConfigured).toBe(true);
    expect(claude.writableRootConfigured).toBeNull();
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

// ── §23 doctor ────────────────────────────────────────────────────────────────

function doctorFor(env: NodeJS.ProcessEnv, claudeHome: string) {
  return runDoctor({ version: "0.2.11", env, claudeHome });
}
function codexCheck(report: ReturnType<typeof runDoctor>, id: string) {
  return report.checks.find((c) => c.id === id);
}

test("doctor: a configured writable root reports ok with the effective ctx home", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    const report = doctorFor(env, claudeHome);
    const c = codexCheck(report, "codex-writable-root");
    expect(c).toBeDefined();
    expect(c!.status).toBe("ok");
    expect(c!.detail).toContain(ctxHome);
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

test("doctor: a missing writable root warns and suggests `ctx repair codex`", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    // Drop the root but keep the (healthy) hook + skill so codex stays detected.
    writeFileSync(codexConfigFile(codexHome), `[sandbox_workspace_write]\nnetwork_access = true\n`);
    const report = doctorFor(env, claudeHome);
    const c = codexCheck(report, "codex-writable-root");
    expect(c!.status).toBe("warn");
    expect(c!.fix).toContain("ctx repair codex");
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

test("doctor: a malformed Codex config is handled safely (warn, never a crash)", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    writeFileSync(codexConfigFile(codexHome), `[sandbox_workspace_write]\nwritable_roots = ["oops\n`);
    // Must not throw.
    const report = doctorFor(env, claudeHome);
    const c = codexCheck(report, "codex-writable-root");
    expect(c!.status).toBe("warn");
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});

test("doctor: a custom CTX_HOME is the path checked (not the default ~/.ctx)", () => {
  const { codexHome, ctxHome, claudeHome } = homes();
  try {
    const env = { CTX_HOME: ctxHome, CODEX_HOME: codexHome, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
    installCodex({ home: codexHome, env });
    const report = doctorFor(env, claudeHome);
    const c = codexCheck(report, "codex-writable-root");
    expect(c!.detail).toContain(ctxHome); // the custom override, not homedir/.ctx
    expect(c!.detail).not.toContain(join(homedir(), ".ctx"));
  } finally {
    cleanup(codexHome, ctxHome, claudeHome);
  }
});
