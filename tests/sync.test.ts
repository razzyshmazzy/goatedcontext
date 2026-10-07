import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import { syncProject, unsyncProject } from "../src/core/project/sync.ts";

// 0.2.9: AGENTS.md is the ONE canonical static path (no .cursor/rules). The flow is
// strictly ctx -> AGENTS.md, managed-block only, never ingesting AGENTS.md back.

function agents(root: string): string {
  return readFileSync(join(root, "AGENTS.md"), "utf8");
}

test("sync writes an AGENTS.md block (repo-always only) and is idempotent; no .cursor/rules", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    const r = t.ctx.repos.resolve(repo.root)!;
    t.ctx.preferences.remember({ rule: "Use Bun here.", scope: "repo", repoId: r.id, applicability: "always" });
    t.ctx.preferences.remember({ rule: "Prefer foreign keys.", scope: "repo", repoId: r.id }); // relevant → excluded

    const first = syncProject(t.ctx, repo.root);
    expect(first.ruleCount).toBe(1);
    expect(first.agentsAction).toBe("created");
    expect(agents(repo.root)).toContain("Use Bun here.");
    expect(agents(repo.root)).not.toContain("Prefer foreign keys."); // relevant not materialized

    // No .cursor/rules file is created (AGENTS.md is the single canonical path).
    expect(existsSync(join(repo.root, ".cursor", "rules", "goatedcontext.mdc"))).toBe(false);

    const second = syncProject(t.ctx, repo.root);
    expect(second.agentsAction).toBe("unchanged");
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("preserves handwritten content before and after the managed block", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    writeFileSync(join(repo.root, "AGENTS.md"), "# Our project\n\nBuild with care.\n\n## Footer\n");
    const r = t.ctx.repos.resolve(repo.root)!;
    t.ctx.preferences.remember({ rule: "Use Bun here.", scope: "repo", repoId: r.id, applicability: "always" });

    syncProject(t.ctx, repo.root);
    const a = agents(repo.root);
    expect(a).toContain("# Our project");
    expect(a).toContain("Build with care.");
    expect(a).toContain("## Footer");
    expect(a).toContain("Use Bun here.");

    // Block update: change the rule set, handwritten content survives.
    t.ctx.preferences.remember({ rule: "Lint before commit.", scope: "repo", repoId: r.id, applicability: "always" });
    syncProject(t.ctx, repo.root);
    const b = agents(repo.root);
    expect(b).toContain("# Our project");
    expect(b).toContain("Lint before commit.");

    // Removal restores the user's file without our block.
    unsyncProject(t.ctx, repo.root);
    const c = agents(repo.root);
    expect(c).toContain("# Our project");
    expect(c).toContain("## Footer");
    expect(c).not.toContain("Use Bun here.");
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("CRLF handwritten content is preserved byte-for-byte outside the block", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    const crlf = "# Title\r\n\r\nHand-written with CRLF.\r\n";
    writeFileSync(join(repo.root, "AGENTS.md"), crlf);
    const r = t.ctx.repos.resolve(repo.root)!;
    t.ctx.preferences.remember({ rule: "Use Bun here.", scope: "repo", repoId: r.id, applicability: "always" });

    syncProject(t.ctx, repo.root);
    const a = agents(repo.root);
    expect(a).toContain("Hand-written with CRLF.\r\n"); // CRLF run intact
    expect(a).toContain("Use Bun here.");
    expect(syncProject(t.ctx, repo.root).agentsAction).toBe("unchanged"); // idempotent with CRLF present
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("two repos stay isolated: each AGENTS.md contains only its own rules", () => {
  const t = makeTestContext();
  const a = makeGitRepo("https://github.com/acme/alpha.git");
  const b = makeGitRepo("https://github.com/acme/beta.git");
  try {
    const ra = t.ctx.repos.resolve(a.root)!;
    const rb = t.ctx.repos.resolve(b.root)!;
    t.ctx.preferences.remember({ rule: "Alpha uses Bun.", scope: "repo", repoId: ra.id, applicability: "always" });
    t.ctx.preferences.remember({ rule: "Beta uses pnpm.", scope: "repo", repoId: rb.id, applicability: "always" });
    // A global always rule must NOT leak into either repo's AGENTS.md.
    t.ctx.preferences.remember({ rule: "Never add dependencies without asking.", scope: "global", applicability: "always" });

    syncProject(t.ctx, a.root);
    syncProject(t.ctx, b.root);

    expect(agents(a.root)).toContain("Alpha uses Bun.");
    expect(agents(a.root)).not.toContain("Beta uses pnpm.");
    expect(agents(a.root)).not.toContain("Never add dependencies"); // no global leakage
    expect(agents(b.root)).toContain("Beta uses pnpm.");
    expect(agents(b.root)).not.toContain("Alpha uses Bun.");
    expect(agents(b.root)).not.toContain("Never add dependencies");
  } finally {
    a.cleanup();
    b.cleanup();
    t.cleanup();
  }
});

test("sync FAILS CLOSED on an AGENTS.md with a malformed managed marker (no truncation)", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    // A user AGENTS.md that happens to contain our begin marker with no matching end,
    // followed by real user content. sync must refuse and preserve every byte.
    const original =
      "# Our project\n\n<!-- goatedcontext:begin -->\nUSER-SENTINEL-MUST-SURVIVE\nmore user notes\n";
    const file = join(repo.root, "AGENTS.md");
    writeFileSync(file, original);
    const r = t.ctx.repos.resolve(repo.root)!;
    t.ctx.preferences.remember({ rule: "Use Bun here.", scope: "repo", repoId: r.id, applicability: "always" });

    expect(() => syncProject(t.ctx, repo.root)).toThrow(/malformed/i);
    expect(readFileSync(file, "utf8")).toBe(original); // byte-for-byte unchanged
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("sync outside a git repo fails cleanly (repo-scoped)", () => {
  const t = makeTestContext();
  try {
    expect(() => syncProject(t.ctx, t.dir)).toThrow(/repo/i);
  } finally {
    t.cleanup();
  }
});
