import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertClaudePermissions,
  removeClaudePermissions,
  detectClaudePermissions,
} from "../src/adapters/claude/permissions.ts";
import {
  upsertCodexRules,
  removeCodexRules,
  detectCodexRules,
  codexRulesHealth,
  codexRulesFile,
} from "../src/adapters/codex/permissions.ts";

/**
 * Narrow permission-rule installers (0.3.5). Isolated temp homes only — never the
 * machine's real agent config. §25.
 */

function scratch(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── Claude ──────────────────────────────────────────────────────────────────

test("Claude: clean install adds narrow allow + deny rules; detect confirms", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    expect(upsertClaudePermissions(file, "linux")).toBe("created");
    const obj = JSON.parse(readFileSync(file, "utf8"));
    // Writes are the AGENT surface only; bare write commands are NOT auto-allowed.
    expect(obj.permissions.allow).toContain("Bash(ctx agent remember:*)");
    expect(obj.permissions.allow).toContain("Bash(ctx agent signal add:*)");
    expect(obj.permissions.allow).toContain("Bash(ctx prefs:*)");
    expect(obj.permissions.allow).not.toContain("Bash(ctx remember:*)");
    expect(obj.permissions.allow).not.toContain("Bash(ctx signal add:*)");
    expect(obj.permissions.deny).toContain("Bash(ctx prefs approve:*)");
    expect(obj.permissions.deny).toContain("Bash(ctx prefs reject:*)");
    expect(detectClaudePermissions(file, "linux")).toBe(true);
  } finally {
    s.cleanup();
  }
});

test("Claude: install is idempotent (second run unchanged, byte-stable)", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    upsertClaudePermissions(file, "linux");
    const before = readFileSync(file, "utf8");
    expect(upsertClaudePermissions(file, "linux")).toBe("unchanged");
    expect(readFileSync(file, "utf8")).toBe(before);
  } finally {
    s.cleanup();
  }
});

test("Claude: preserves unrelated settings, hooks, and permission entries", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        model: "sonnet",
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "ctx hook claude-prompt" }] }] },
        permissions: { allow: ["Bash(git status:*)"], defaultMode: "acceptEdits" },
      }),
    );
    expect(upsertClaudePermissions(file, "linux")).toBe("updated");
    const obj = JSON.parse(readFileSync(file, "utf8"));
    expect(obj.model).toBe("sonnet");
    expect(obj.hooks.UserPromptSubmit).toBeTruthy();
    expect(obj.permissions.allow).toContain("Bash(git status:*)"); // user rule preserved
    expect(obj.permissions.allow).toContain("Bash(ctx agent remember:*)"); // ours added
    expect(obj.permissions.defaultMode).toBe("acceptEdits"); // unrelated perm key kept
  } finally {
    s.cleanup();
  }
});

test("Claude: repair restores a missing ctx rule", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    upsertClaudePermissions(file, "linux");
    // Simulate drift: a user removed our allow rule.
    const obj = JSON.parse(readFileSync(file, "utf8"));
    obj.permissions.allow = obj.permissions.allow.filter((r: string) => r !== "Bash(ctx agent remember:*)");
    writeFileSync(file, JSON.stringify(obj));
    expect(detectClaudePermissions(file, "linux")).toBe(false);
    expect(upsertClaudePermissions(file, "linux")).toBe("updated");
    expect(detectClaudePermissions(file, "linux")).toBe(true);
  } finally {
    s.cleanup();
  }
});

test("Claude: uninstall removes only ctx rules, keeps unrelated ones", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(git status:*)"] } }));
    upsertClaudePermissions(file, "linux");
    expect(removeClaudePermissions(file)).toBe("removed");
    const obj = JSON.parse(readFileSync(file, "utf8"));
    expect(obj.permissions.allow).toEqual(["Bash(git status:*)"]);
    expect(obj.permissions.allow.some((r: string) => r.startsWith("Bash(ctx"))).toBe(false);
    expect(obj.permissions.deny).toBeUndefined(); // emptied deny array dropped
  } finally {
    s.cleanup();
  }
});

test("Claude: uninstall drops an emptied permissions object entirely", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    upsertClaudePermissions(file, "linux"); // creates permissions with only our rules
    removeClaudePermissions(file);
    const obj = JSON.parse(readFileSync(file, "utf8"));
    expect(obj.permissions).toBeUndefined();
  } finally {
    s.cleanup();
  }
});

test("Claude: a present-but-unparseable settings.json is never clobbered", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    writeFileSync(file, "{ not valid json ");
    expect(upsertClaudePermissions(file, "linux")).toBe("error");
    expect(readFileSync(file, "utf8")).toBe("{ not valid json "); // untouched
  } finally {
    s.cleanup();
  }
});

test("Claude: Windows installs BOTH ctx and ctx.cmd rules", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    upsertClaudePermissions(file, "win32");
    const obj = JSON.parse(readFileSync(file, "utf8"));
    expect(obj.permissions.allow).toContain("Bash(ctx agent remember:*)");
    expect(obj.permissions.allow).toContain("Bash(ctx.cmd agent remember:*)");
    expect(obj.permissions.deny).toContain("Bash(ctx.cmd prefs approve:*)");
    expect(detectClaudePermissions(file, "win32")).toBe(true);
  } finally {
    s.cleanup();
  }
});

test("Claude: SECURITY MIGRATION — a stale 0.3.5/0.3.6 config loses the bare-write rules", () => {
  const s = scratch("ctx-perm-claude-");
  try {
    const file = join(s.dir, "settings.json");
    // Seed exactly what 0.3.5/0.3.6 installed: bare write rules + reads + an unrelated rule.
    writeFileSync(
      file,
      JSON.stringify({
        permissions: {
          allow: [
            "Bash(git status:*)",
            "Bash(ctx remember:*)",
            "Bash(ctx propose:*)",
            "Bash(ctx signal add:*)",
            "Bash(ctx prefs:*)",
          ],
          deny: ["Bash(ctx prefs approve:*)"],
        },
      }),
    );
    expect(upsertClaudePermissions(file, "linux")).toBe("updated");
    const allow = JSON.parse(readFileSync(file, "utf8")).permissions.allow as string[];
    // The dangerous bare-write rules are GONE.
    expect(allow).not.toContain("Bash(ctx remember:*)");
    expect(allow).not.toContain("Bash(ctx propose:*)");
    expect(allow).not.toContain("Bash(ctx signal add:*)");
    // The new agent-path rules are present; the unrelated user rule is preserved.
    expect(allow).toContain("Bash(ctx agent remember:*)");
    expect(allow).toContain("Bash(git status:*)");
  } finally {
    s.cleanup();
  }
});

// ── Codex ─────────────────────────────────────────────────────────────────

test("Codex: clean install writes a goatedcontext-owned rules file", () => {
  const s = scratch("ctx-perm-codex-");
  try {
    expect(upsertCodexRules(s.dir, "linux")).toBe("created");
    const body = readFileSync(codexRulesFile(s.dir), "utf8");
    expect(body).toContain("goatedcontext-managed:v");
    expect(body).toContain('prefix_rule(');
    // Writes are the AGENT surface; bare write prefixes are not present.
    expect(body).toContain('pattern = ["ctx", "agent", "remember"]');
    expect(body).toContain('pattern = ["ctx", "agent", "signal", "add"]');
    expect(body).not.toContain('pattern = ["ctx", "remember"]');
    expect(body).not.toContain('pattern = ["ctx", "signal", "add"]');
    expect(body).toContain('decision = "allow"');
    // Gated commands render as prompt, not allow.
    expect(body).toContain('pattern = ["ctx", "prefs", "approve"]');
    expect(body).toContain('decision = "prompt"');
    expect(detectCodexRules(s.dir, "linux")).toBe(true);
    expect(codexRulesHealth(s.dir, "linux")).toBe("current");
  } finally {
    s.cleanup();
  }
});

test("Codex: install is idempotent and never touches config.toml", () => {
  const s = scratch("ctx-perm-codex-");
  try {
    upsertCodexRules(s.dir, "linux");
    expect(upsertCodexRules(s.dir, "linux")).toBe("unchanged");
    // The rules file is separate from config.toml; we never create/modify config.toml.
    expect(existsSync(join(s.dir, "config.toml"))).toBe(false);
  } finally {
    s.cleanup();
  }
});

test("Codex: repair rewrites a stale rules file", () => {
  const s = scratch("ctx-perm-codex-");
  try {
    upsertCodexRules(s.dir, "linux");
    writeFileSync(codexRulesFile(s.dir), "# stale hand-edited junk\n");
    expect(codexRulesHealth(s.dir, "linux")).toBe("stale");
    expect(upsertCodexRules(s.dir, "linux")).toBe("updated");
    expect(codexRulesHealth(s.dir, "linux")).toBe("current");
  } finally {
    s.cleanup();
  }
});

test("Codex: uninstall removes only our rules file", () => {
  const s = scratch("ctx-perm-codex-");
  try {
    upsertCodexRules(s.dir, "linux");
    expect(removeCodexRules(s.dir)).toBe("removed");
    expect(existsSync(codexRulesFile(s.dir))).toBe(false);
    expect(removeCodexRules(s.dir)).toBe("absent"); // idempotent
  } finally {
    s.cleanup();
  }
});

test("Codex: Windows rules include ctx.cmd patterns", () => {
  const s = scratch("ctx-perm-codex-");
  try {
    upsertCodexRules(s.dir, "win32");
    const body = readFileSync(codexRulesFile(s.dir), "utf8");
    expect(body).toContain('pattern = ["ctx", "agent", "remember"]');
    expect(body).toContain('pattern = ["ctx.cmd", "agent", "remember"]');
  } finally {
    s.cleanup();
  }
});
