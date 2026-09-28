import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { installClaude } from "../src/adapters/claude/installer.ts";
import {
  upsertPromptHook,
  removePromptHook,
  detectPromptHook,
  formatHookContext,
  HOOK_MARKER,
} from "../src/adapters/claude/hook.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ctx-hook-"));
}

// ---- settings.json merge -----------------------------------------------------

test("install adds a UserPromptSubmit hook and status detects it", () => {
  const home = tmp();
  const r = installClaude({ claudeHome: home });
  expect(r.hookAction).toBe("created");
  const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  expect(cmd).toContain(HOOK_MARKER);
  expect(detectPromptHook(join(home, "settings.json"))).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

test("install is idempotent for the hook", () => {
  const home = tmp();
  installClaude({ claudeHome: home });
  const second = installClaude({ claudeHome: home });
  expect(second.hookAction).toBe("unchanged");
  const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  expect(settings.hooks.UserPromptSubmit.length).toBe(1); // no duplication
  rmSync(home, { recursive: true, force: true });
});

test("install preserves unrelated hooks and settings", () => {
  const home = tmp();
  const file = join(home, "settings.json");
  require("node:fs").mkdirSync(home, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      model: "some-model",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --run" }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
      },
    }),
    "utf8",
  );
  installClaude({ claudeHome: home });
  const s = JSON.parse(readFileSync(file, "utf8"));
  expect(s.model).toBe("some-model"); // unrelated setting preserved
  expect(s.hooks.PostToolUse[0].hooks[0].command).toBe("audit.sh"); // unrelated hook preserved
  const ups = s.hooks.UserPromptSubmit;
  const commands = ups.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  expect(commands).toContain("other-tool --run"); // pre-existing UPS hook preserved
  expect(commands.some((c: string) => c.includes(HOOK_MARKER))).toBe(true); // ours added
  rmSync(home, { recursive: true, force: true });
});

test("upgrade from a v0.1.1-style install (skills + CLAUDE.md, no hook) adds the hook", () => {
  const home = tmp();
  // Simulate old install: skills + CLAUDE.md present, but settings.json has no hook.
  installClaude({ claudeHome: home, disableHook: true }); // creates skills+instructions, no hook
  expect(detectPromptHook(join(home, "settings.json"))).toBe(false);
  const r = installClaude({ claudeHome: home }); // upgrade
  expect(["created", "updated"]).toContain(r.hookAction);
  expect(detectPromptHook(join(home, "settings.json"))).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

test("--disable-hook removes our hook but keeps skills and unrelated hooks", () => {
  const home = tmp();
  const file = join(home, "settings.json");
  installClaude({ claudeHome: home });
  // add an unrelated UPS hook alongside ours
  const s = JSON.parse(readFileSync(file, "utf8"));
  s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "keepme --x" }] });
  writeFileSync(file, JSON.stringify(s), "utf8");

  const r = installClaude({ claudeHome: home, disableHook: true });
  expect(r.hookAction).toBe("removed");
  expect(detectPromptHook(file)).toBe(false);
  const after = JSON.parse(readFileSync(file, "utf8"));
  const commands = after.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  expect(commands).toContain("keepme --x"); // unrelated hook survives
  expect(existsSync(join(home, "skills", "context", "SKILL.md"))).toBe(true); // skills kept
  rmSync(home, { recursive: true, force: true });
});

test("invalid settings.json is left untouched (hookAction=error)", () => {
  const home = tmp();
  require("node:fs").mkdirSync(home, { recursive: true });
  const file = join(home, "settings.json");
  writeFileSync(file, "{ this is not valid json ", "utf8");
  const r = installClaude({ claudeHome: home });
  expect(r.hookAction).toBe("error");
  expect(readFileSync(file, "utf8")).toBe("{ this is not valid json "); // unchanged
  rmSync(home, { recursive: true, force: true });
});

test("removePromptHook on a file without our hook reports absent", () => {
  const home = tmp();
  require("node:fs").mkdirSync(home, { recursive: true });
  const file = join(home, "settings.json");
  writeFileSync(file, JSON.stringify({ hooks: {} }), "utf8");
  expect(removePromptHook(file)).toBe("absent");
  expect(upsertPromptHook(file, "ctx hook claude-prompt")).toBe("created");
  rmSync(home, { recursive: true, force: true });
});

// ---- injection formatting ----------------------------------------------------

test("formatHookContext returns null when nothing relevant (no junk injected)", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer relational constraints and database-enforced invariants.",
    category: "database",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Rename the local variable x to count.",
    track: false,
  });
  expect(formatHookContext(result)).toBeNull();
  t.cleanup();
});

test("formatHookContext emits a compact block for relevant prefs", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before adding a new package.",
    category: "dependencies",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Install a date parsing package.",
    track: false,
  });
  const block = formatHookContext(result)!;
  expect(block).toContain("<ctx-developer-context>");
  expect(block).toContain("Prefer existing dependencies before adding a new package.");
  expect(block).toContain("</ctx-developer-context>");
  // no confidence internals / evidence leaked
  expect(block).not.toContain("confidence");
  expect(block).not.toContain("evidence");
  t.cleanup();
});

test("formatHookContext never includes secret values", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "supabase-test" });
  const secret = "FAKE_SECRET_sb_zzz_123";
  t.ctx.environments.setVariable(env.id, "SUPABASE_ANON_KEY", secret);
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before adding a new package.",
    category: "dependencies",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Install a package and call the supabase API.",
    track: false,
  });
  const block = formatHookContext(result) ?? "";
  expect(block).not.toContain(secret);
  // env NAME may appear, value never
  t.cleanup();
});

// ---- provenance --------------------------------------------------------------

test("propose stores agent/session provenance on evidence", () => {
  const t = makeTestContext();
  const { preference } = t.ctx.preferences.propose({
    rule: "Prefer parameterized SQL queries over string concatenation.",
    category: "security",
    scope: "global",
    evidence: "user asked to record this",
    agentId: "claude-code",
    sessionId: "sess-abc-123",
  });
  const ev = t.ctx.preferences.evidenceFor(preference.id);
  expect(ev[0]!.agentId).toBe("claude-code");
  expect(ev[0]!.sessionId).toBe("sess-abc-123");
  t.cleanup();
});
