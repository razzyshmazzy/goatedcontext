import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installClaude,
  repairClaude,
  uninstallClaude,
} from "../src/adapters/claude/installer.ts";
import { detectPromptHook, removePromptHook, HOOK_MARKER } from "../src/adapters/claude/hook.ts";
import { CTX_INSTRUCTION_BEGIN } from "../src/adapters/claude/skills.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const skillFile = (home: string, dir: string) => join(home, "skills", dir, "SKILL.md");
const claudeMd = (home: string) => join(home, "CLAUDE.md");
const settings = (home: string) => join(home, "settings.json");

// ---- repair -----------------------------------------------------------------

test("repair rewrites a deleted skill and restores a missing hook", () => {
  const home = tmp("ctx-repair-");
  installClaude({ claudeHome: home });

  // Damage: delete a skill file and remove the hook.
  rmSync(skillFile(home, "context"), { force: true });
  removePromptHook(settings(home));
  expect(detectPromptHook(settings(home))).toBe(false);

  const result = repairClaude({ claudeHome: home });
  expect(existsSync(skillFile(home, "context"))).toBe(true);
  expect(result.skills.find((s) => s.dir === "context")!.action).toBe("restored");
  expect(result.skills.find((s) => s.dir === "context-env")!.action).toBe("ok");
  expect(detectPromptHook(settings(home))).toBe(true);

  rmSync(home, { recursive: true, force: true });
});

test("repair FAILS CLOSED on a damaged (end-marker-less) block — never truncates", () => {
  const home = tmp("ctx-repair-");
  installClaude({ claudeHome: home });
  const file = claudeMd(home);

  // A begin marker with no matching end is ambiguous: we cannot tell where the managed
  // region stops, so repair must refuse rather than delete everything after it (the
  // old behavior truncated to EOF, destroying any user content below the marker).
  const damaged =
    "# My rules\n\nAlways write tests.\n\n" +
    CTX_INSTRUCTION_BEGIN +
    "\nIMPORTANT USER PROSE BELOW A STRAY MARKER\nmore user lines\n";
  writeFileSync(file, damaged, "utf8");

  expect(() => repairClaude({ claudeHome: home })).toThrow(/malformed/i);
  // Byte-for-byte unchanged: no truncation, nothing appended.
  expect(readFileSync(file, "utf8")).toBe(damaged);

  rmSync(home, { recursive: true, force: true });
});

test("repairing a healthy install is idempotent (everything ok/unchanged)", () => {
  const home = tmp("ctx-repair-");
  installClaude({ claudeHome: home });

  const first = repairClaude({ claudeHome: home });
  expect(first.skills.every((s) => s.action === "ok")).toBe(true);
  expect(first.instructionsAction).toBe("ok");
  expect(first.hookAction).toBe("unchanged");

  const second = repairClaude({ claudeHome: home });
  expect(second.skills.every((s) => s.action === "ok")).toBe(true);
  expect(second.instructionsAction).toBe("ok");
  expect(second.hookAction).toBe("unchanged");

  rmSync(home, { recursive: true, force: true });
});

test("repair preserves unrelated hooks and settings", () => {
  const home = tmp("ctx-repair-");
  installClaude({ claudeHome: home });
  const file = settings(home);
  const s = JSON.parse(readFileSync(file, "utf8"));
  s.model = "some-model";
  s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "other-tool --run" }] });
  s.hooks.PostToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }];
  writeFileSync(file, JSON.stringify(s), "utf8");

  repairClaude({ claudeHome: home });
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.model).toBe("some-model");
  expect(after.hooks.PostToolUse[0].hooks[0].command).toBe("audit.sh");
  const cmds = after.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  expect(cmds).toContain("other-tool --run");
  expect(cmds.some((c: string) => c.includes(HOOK_MARKER))).toBe(true);

  rmSync(home, { recursive: true, force: true });
});

// ---- uninstall --------------------------------------------------------------

test("uninstall removes ctx skills, instruction block, and hook", () => {
  const home = tmp("ctx-uninstall-");
  installClaude({ claudeHome: home });

  const result = uninstallClaude({ claudeHome: home });
  expect(result.removedSkills.sort()).toEqual(["context", "context-env", "context-learn"]);
  expect(existsSync(skillFile(home, "context"))).toBe(false);
  expect(result.instructionsAction).toBe("removed");
  expect(readFileSync(claudeMd(home), "utf8")).not.toContain(CTX_INSTRUCTION_BEGIN);
  expect(result.hookAction).toBe("removed");
  expect(detectPromptHook(settings(home))).toBe(false);

  rmSync(home, { recursive: true, force: true });
});

test("uninstall preserves unrelated skills, hooks, and CLAUDE.md content", () => {
  const home = tmp("ctx-uninstall-");
  installClaude({ claudeHome: home });

  // Unrelated skill.
  const otherSkill = join(home, "skills", "my-skill", "SKILL.md");
  require("node:fs").mkdirSync(join(home, "skills", "my-skill"), { recursive: true });
  writeFileSync(otherSkill, "# my skill", "utf8");

  // Unrelated user instructions around the ctx block.
  const md = claudeMd(home);
  writeFileSync(md, "# My rules\n\nAlways write tests.\n\n" + readFileSync(md, "utf8"), "utf8");

  // Unrelated hook.
  const st = settings(home);
  const s = JSON.parse(readFileSync(st, "utf8"));
  s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "keepme --x" }] });
  writeFileSync(st, JSON.stringify(s), "utf8");

  uninstallClaude({ claudeHome: home });

  expect(existsSync(otherSkill)).toBe(true);
  const content = readFileSync(md, "utf8");
  expect(content).toContain("Always write tests.");
  expect(content).not.toContain(CTX_INSTRUCTION_BEGIN);
  const cmds = JSON.parse(readFileSync(st, "utf8")).hooks.UserPromptSubmit.flatMap((g: any) =>
    g.hooks.map((h: any) => h.command),
  );
  expect(cmds).toContain("keepme --x");
  expect(cmds.some((c: string) => c.includes(HOOK_MARKER))).toBe(false);

  rmSync(home, { recursive: true, force: true });
});

test("uninstall is idempotent (second run reports nothing to remove)", () => {
  const home = tmp("ctx-uninstall-");
  installClaude({ claudeHome: home });
  uninstallClaude({ claudeHome: home });
  const second = uninstallClaude({ claudeHome: home });
  expect(second.removedSkills).toHaveLength(0);
  expect(second.instructionsAction).toBe("absent");
  expect(second.hookAction).toBe("absent");
  rmSync(home, { recursive: true, force: true });
});

// ---- CLI: uninstall must not touch preferences ------------------------------

test(
  "CLI uninstall claude keeps stored preferences intact",
  async () => {
    const ctxHome = tmp("ctx-uninstall-ctxhome-");
    const claudeHome = tmp("ctx-uninstall-claude-");
    // Seed a preference in the ctx home.
    const db = openDatabase(resolvePaths({ CTX_HOME: ctxHome }));
    try {
      new PreferenceService(db).remember({ rule: "Prefer pnpm.", category: "dependencies", scope: "global" });
    } finally {
      db.close();
    }
    installClaude({ claudeHome });

    const proc = Bun.spawn([BUN, "run", INDEX, "uninstall", "claude", "--claude-home", claudeHome, "--json"], {
      env: { ...process.env, CTX_HOME: ctxHome, CTX_SECRET_BACKEND: "file" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out).hookAction).toBe("removed");

    // Preference must still be there.
    const list = Bun.spawnSync([BUN, "run", INDEX, "prefs", "--json"], {
      env: { ...process.env, CTX_HOME: ctxHome, CTX_SECRET_BACKEND: "file" },
    });
    const prefs = JSON.parse(list.stdout.toString());
    expect(prefs).toHaveLength(1);
    expect(prefs[0].rule).toBe("Prefer pnpm.");

    rmSync(ctxHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "CLI install claude --repair restores a deleted skill",
  async () => {
    const claudeHome = tmp("ctx-repair-cli-");
    installClaude({ claudeHome });
    rmSync(skillFile(claudeHome, "context"), { force: true });

    const proc = Bun.spawn(
      [BUN, "run", INDEX, "install", "claude", "--claude-home", claudeHome, "--repair", "--json"],
      { env: { ...process.env, CTX_SECRET_BACKEND: "file" }, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const result = JSON.parse(out);
    expect(result.skills.find((s: any) => s.dir === "context").action).toBe("restored");
    expect(existsSync(skillFile(claudeHome, "context"))).toBe(true);

    rmSync(claudeHome, { recursive: true, force: true });
  },
  TIMEOUT,
);
