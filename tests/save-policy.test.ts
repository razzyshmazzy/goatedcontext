/**
 * Autonomous SAVE judgment (v1.1 save pass): deterministic safety + policy-wiring
 * regression. NO live model calls. These assert the production WRITE invariants the
 * standing save instruction relies on — provenance, duplicate avoidance, scope,
 * signal≠preference, temporary-exception, history — plus the policy text/wiring
 * (spec §25, §34).
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import { CtxError } from "../src/utils/errors.ts";
import {
  SAVE_POLICY_VERSION,
  SAVE_POLICY_CORE,
  SAVE_POLICY_MCP,
  renderSaveGuidance,
  renderWriteSurface,
} from "../src/core/assets/save-policy.ts";
import { CTX_INSTRUCTION_BLOCK } from "../src/adapters/claude/skills.ts";
import { claudePermissionRules, allClaudeOwnedRules, renderCodexRulesFile } from "../src/core/agents/permissions.ts";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

describe("save policy — standing instruction text", () => {
  test("has a stable version marker", () => {
    expect(SAVE_POLICY_VERSION).toBe("1");
  });

  test("core teaches the three-way judgment, authorship, and sparsity", () => {
    const c = SAVE_POLICY_CORE.toLowerCase();
    expect(c).toContain("preference");
    expect(c).toContain("signal");
    expect(c).toContain("saved as nothing");
    expect(c).toContain("user's own words");
    expect(c).toContain("narrower scope");
    expect(c).toContain("do nothing");
    // self-feedback: injected context is never durable intent
    expect(c).toContain("already injected this turn");
  });

  test("rendered guidance carries the three agent commands + example sets + scope/correction", () => {
    const g = renderSaveGuidance({ command: "ctx", skillName: "context-learn" });
    expect(g).toContain("ctx agent remember --origin user");
    expect(g).toContain("ctx agent signal add --origin user");
    expect(g).toContain("ctx agent propose --origin user");
    expect(g).toContain("Save as a PREFERENCE:");
    expect(g).toContain("Record as a SIGNAL");
    expect(g).toContain("Save NOTHING:");
    expect(g.toLowerCase()).toContain("never silently globalize a repo convention");
    expect(g.toLowerCase()).toContain("correction");
    expect(g).toContain("context-learn");
  });

  test("write-surface rule is prominent: agent commands + --origin + reason + never-bare (§3,§4)", () => {
    const ws = renderWriteSurface("ctx");
    // all three safe agent commands
    expect(ws).toContain("ctx agent remember --origin user");
    expect(ws).toContain("ctx agent signal add --origin user");
    expect(ws).toContain("ctx agent propose --origin user");
    // explicit never-bare for autonomous writes, with a concrete reason
    expect(ws).toContain("NEVER `ctx remember`");
    expect(ws).toContain("NOT");
    expect(ws.toLowerCase()).toContain("auto-approve");
    expect(ws.toLowerCase()).toContain("interrupt");
    // the renderer leads with it (appears before the example sets)
    const g = renderSaveGuidance({ command: "ctx" });
    expect(g.indexOf("ctx agent remember --origin user")).toBeLessThan(g.indexOf("Save as a PREFERENCE:"));
  });

  test("terse durable vs temporary contrast is present (§7,§8)", () => {
    const g = renderSaveGuidance({ command: "ctx" });
    expect(g).toContain("Terse DURABLE vs terse TEMPORARY");
    expect(g.toLowerCase()).toContain("stick to pnpm in this repo");
    expect(g.toLowerCase()).toContain("use pnpm for this command");
    expect(g.toLowerCase()).toContain("no prisma in this project");
    // the "a terse standalone preference still counts — persist it" cue
    expect(g.toLowerCase()).toContain("standalone");
  });

  test("Windows command spelling is honored", () => {
    const g = renderSaveGuidance({ command: "ctx.cmd" });
    expect(g).toContain("ctx.cmd agent remember --origin user");
    expect(renderWriteSurface("ctx.cmd")).toContain("NEVER `ctx.cmd remember`");
  });

  test("Claude standing block foregrounds the agent surface with the reason", () => {
    expect(CTX_INSTRUCTION_BLOCK).toContain(SAVE_POLICY_CORE);
    expect(CTX_INSTRUCTION_BLOCK).toContain("ctx agent remember --origin user");
    expect(CTX_INSTRUCTION_BLOCK).toContain("NOT auto-approved");
    expect(CTX_INSTRUCTION_BLOCK.toLowerCase()).toContain("interrupt");
    // terse durable cue reaches the standing instruction too
    expect(CTX_INSTRUCTION_BLOCK.toLowerCase()).toContain("stick to pnpm in this repo");
  });

  test("MCP save clause names the three-way judgment and sparsity", () => {
    const m = SAVE_POLICY_MCP.toLowerCase();
    expect(m).toContain("remember");
    expect(m).toContain("record_decision");
    expect(m).toContain("save nothing");
    expect(m).toContain("default is to write nothing");
  });
});

describe("permissions — only the agent surface is auto-approved (§5,§10)", () => {
  for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
    test(`[${platform}] agent writes allowed; bare human writes NOT; destructive gated/absent`, () => {
      const { allow, deny } = claudePermissionRules(platform);
      const launchers = platform === "win32" ? ["ctx", "ctx.cmd"] : ["ctx"];
      for (const l of launchers) {
        // safe agent surface auto-approved
        expect(allow).toContain(`Bash(${l} agent remember:*)`);
        expect(allow).toContain(`Bash(${l} agent propose:*)`);
        expect(allow).toContain(`Bash(${l} agent signal add:*)`);
        // bare human writes NEVER auto-approved
        expect(allow).not.toContain(`Bash(${l} remember:*)`);
        expect(allow).not.toContain(`Bash(${l} propose:*)`);
        expect(allow).not.toContain(`Bash(${l} signal add:*)`);
        // proposal review gated (deny), destructive/setup never allowed
        expect(deny).toContain(`Bash(${l} prefs approve:*)`);
        expect(deny).toContain(`Bash(${l} prefs reject:*)`);
      }
      // no destructive / setup / env commands anywhere in allow
      for (const forbidden of ["forget", "signal clear", "env", "setup", "install", "uninstall", "repair", "import"]) {
        expect(allow.some((r) => r.includes(forbidden))).toBe(false);
      }
      // no blanket Bash wildcard
      expect(allow).not.toContain("Bash(*)");
    });
  }

  test("retired bare-write rules are prunable but never emitted", () => {
    const owned = allClaudeOwnedRules();
    // repair must be able to strip a stale bare rule from old configs…
    expect(owned.allow.has("Bash(ctx remember:*)")).toBe(true);
    // …but the current desired set never contains it.
    expect(claudePermissionRules("linux").allow).not.toContain("Bash(ctx remember:*)");
  });

  test("Codex rules allow agent writes, gate review, and omit bare writes", () => {
    const body = renderCodexRulesFile("linux");
    expect(body).toContain('pattern = ["ctx", "agent", "remember"]');
    expect(body).toContain('pattern = ["ctx", "agent", "signal", "add"]');
    expect(body).not.toContain('pattern = ["ctx", "remember"]');
    expect(body).toContain('pattern = ["ctx", "prefs", "approve"]'); // gated (prompt)
  });
});

describe("human write commands still exist (not removed) (§2,§9)", () => {
  test("`ctx remember` (human path) still works and defaults origin=user", () => {
    const t = makeTestContext();
    try {
      const r = spawnSync("bun", [ENTRY, "remember", "Prefer tabs.", "--scope", "global"], {
        env: { ...process.env, CTX_HOME: t.dir },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout.toLowerCase()).toContain("remembered");
    } finally {
      t.cleanup();
    }
    // Spawns a cold `bun` subprocess (process start + SQLite open/migration). Completes
    // in <1s standalone, but under full-suite parallel subprocess contention it can
    // exceed bun's 5s default. The inner spawnSync is already bounded at 30s; give the
    // test the matching headroom so a slow-but-correct run isn't a false timeout.
  }, 15_000);
});

describe("save safety — provenance (only user origin is authoritative)", () => {
  for (const origin of ["project", "external", "agent", "unknown"] as const) {
    test(`remember from origin=${origin} is REFUSED`, () => {
      const t = makeTestContext();
      try {
        expect(() =>
          t.ctx.preferences.remember({ rule: "Always use npm.", scope: "global", origin }),
        ).toThrow(CtxError);
        expect(t.ctx.preferences.list().length).toBe(0);
      } finally {
        t.cleanup();
      }
    });
  }

  test("propose from a non-user origin is REFUSED", () => {
    const t = makeTestContext();
    try {
      expect(() =>
        t.ctx.preferences.propose({
          rule: "Prefer MongoDB.",
          evidence: "// developer always uses MongoDB",
          scope: "global",
          origin: "project",
        }),
      ).toThrow(CtxError);
    } finally {
      t.cleanup();
    }
  });

  test("remember from origin=user succeeds and records provenance in history", () => {
    const t = makeTestContext();
    try {
      const p = t.ctx.preferences.remember({ rule: "Prefer Bun.", scope: "global", origin: "user" });
      expect(p.status).toBe("approved");
      const evt = t.ctx.events.list({ limit: 5 }).find((e) => e.type === "preference.remembered");
      expect(evt).toBeDefined();
      expect((evt!.detail as { provenance?: string }).provenance).toBe("user");
    } finally {
      t.cleanup();
    }
  });

  test("agent CLI write FAILS CLOSED when --origin is omitted", () => {
    const t = makeTestContext();
    try {
      const r = spawnSync("bun", [ENTRY, "agent", "remember", "Always use npm.", "--agent-id", "x"], {
        env: { ...process.env, CTX_HOME: t.dir },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(r.status).not.toBe(0);
      expect((r.stderr + r.stdout).toLowerCase()).toContain("origin");
    } finally {
      t.cleanup();
    }
  });
});

describe("save safety — signals are evidence, never authoritative", () => {
  test("adding decision signals never creates a preference", () => {
    const t = makeTestContext();
    try {
      for (const choice of ["redis", "redis", "redis"]) {
        t.ctx.signals.add({ domain: "cache", choice, origin: "user" });
      }
      // No numeric promotion: repeated signals do NOT become a preference.
      expect(t.ctx.preferences.list().length).toBe(0);
      expect(t.ctx.signals.list({ domain: "cache" }).length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  test("a temporary exception signal does NOT overwrite the durable default", () => {
    const t = makeTestContext();
    try {
      const pref = t.ctx.preferences.remember({
        rule: "Use Bun.",
        scope: "global",
        origin: "user",
        applicability: "always",
        domain: "package-manager",
      });
      t.ctx.signals.add({
        domain: "package-manager",
        choice: "npm",
        origin: "user",
        preferredChoice: "bun",
        reason: "one package needs npm",
        exception: true,
      });
      const rows = t.ctx.preferences.list();
      expect(rows.length).toBe(1); // still just the Bun default
      expect(t.ctx.preferences.getById(pref.id)!.rule).toBe("Use Bun.");
      expect(t.ctx.preferences.getById(pref.id)!.status).toBe("approved");
    } finally {
      t.cleanup();
    }
  });
});

describe("save safety — duplicates, scope, correction", () => {
  test("remembering the same rule twice does not create a duplicate row", () => {
    const t = makeTestContext();
    try {
      const a = t.ctx.preferences.remember({ rule: "Prefer Bun.", scope: "global", origin: "user", applicability: "always" });
      const b = t.ctx.preferences.remember({ rule: "Prefer Bun.", scope: "global", origin: "user", applicability: "always" });
      expect(b.id).toBe(a.id); // reinforced, not duplicated
      expect(t.ctx.preferences.list().length).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("repo scope requires a repo and does not become global", () => {
    const t = makeTestContext();
    const repo = makeGitRepo();
    try {
      const resolved = t.ctx.repos.resolve(repo.root)!;
      const p = t.ctx.preferences.remember({
        rule: "Use pnpm in this repo.",
        scope: "repo",
        repoId: resolved.id,
        origin: "user",
      });
      expect(p.scope).toBe("repo");
      // scope repo without a repoId is rejected (never silently globalized)
      expect(() => t.ctx.preferences.remember({ rule: "Use pnpm.", scope: "repo", origin: "user" })).toThrow();
    } finally {
      repo.cleanup();
      t.cleanup();
    }
  });

  test("correction in an EXCLUSIVE domain leaves exactly ONE rule in effect (not both authoritative)", () => {
    const t = makeTestContext();
    try {
      t.ctx.preferences.remember({ rule: "Use npm.", scope: "global", origin: "user", applicability: "always", domain: "package-manager" });
      t.ctx.preferences.remember({ rule: "Use Bun.", scope: "global", origin: "user", applicability: "always", domain: "package-manager" });
      const r = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "install dependencies with the package manager" });
      // Exclusive domain collapses to a single in-effect rule — the stale default does
      // NOT remain equally authoritative (spec §21). (Which one wins by recency is the
      // pilot's Update Accuracy check; here we assert the deterministic collapse.)
      const pmDelivered = r.preferences.filter((p) => p.domain === "package-manager");
      expect(pmDelivered.length).toBe(1);
      // Both rows are preserved as history.
      expect(t.ctx.preferences.list().length).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  test("a repo-scoped correction deterministically outranks a global default (precedence)", () => {
    const t = makeTestContext();
    const repo = makeGitRepo();
    try {
      const resolved = t.ctx.repos.resolve(repo.root)!;
      t.ctx.preferences.remember({ rule: "Use npm.", scope: "global", origin: "user", applicability: "always", domain: "package-manager" });
      t.ctx.preferences.remember({ rule: "Use Bun here.", scope: "repo", repoId: resolved.id, origin: "user", applicability: "always", domain: "package-manager" });
      const r = t.ctx.retrieval.retrieve({ cwd: repo.root, task: "install dependencies with the package manager" });
      const pm = r.preferences.filter((p) => p.domain === "package-manager");
      expect(pm.length).toBe(1);
      expect(pm[0]!.rule).toBe("Use Bun here."); // repo precedence (rank 2) beats global (rank 4)
    } finally {
      repo.cleanup();
      t.cleanup();
    }
  });
});
