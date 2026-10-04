import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import {
  buildProjection,
  selectStaticPreferences,
  renderAgentsBlock,
  AGENTS_BEGIN,
  AGENTS_END,
} from "../src/core/project/projection.ts";

// Corrected 0.2.9 policy: AGENTS.md materializes ONLY repo-scoped, approved/locked,
// always preferences. These tests prove every OTHER class is excluded.

function staticRules(ctx: Parameters<typeof buildProjection>[0], cwd: string): string[] {
  return buildProjection(ctx, cwd).rules.map((r) => r.rule);
}

test("materializes exactly repo approved/locked always; excludes every other class", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    const r = t.ctx.repos.resolve(repo.root)!;

    const repoApprovedAlways = t.ctx.preferences.remember({ rule: "Use Bun for dev commands.", scope: "repo", repoId: r.id, applicability: "always" });
    const repoLockedAlways = t.ctx.preferences.remember({ rule: "Run tests before pushing.", scope: "repo", repoId: r.id, applicability: "always", status: "locked" });

    // Everything below must be EXCLUDED from AGENTS.md:
    const globalAlways = t.ctx.preferences.remember({ rule: "Never add dependencies without asking.", scope: "global", applicability: "always" });
    const globalRelevant = t.ctx.preferences.remember({ rule: "Prefer PostgreSQL for relational data.", scope: "global" });
    const repoRelevant = t.ctx.preferences.remember({ rule: "Prefer foreign keys for relational integrity.", scope: "repo", repoId: r.id, applicability: "relevant" });
    const repoConditional = t.ctx.preferences.remember({ rule: "Use strict TypeScript.", scope: "repo", repoId: r.id, condition: { language: "typescript" } });
    const proposed = t.ctx.preferences.propose({ rule: "Always use tabs.", scope: "repo", repoId: r.id, applicability: "always", evidence: "seen" }).preference;
    const rejected = t.ctx.preferences.remember({ rule: "Always use four spaces.", scope: "repo", repoId: r.id, applicability: "always" });
    t.ctx.preferences.reject(rejected.id, { expectedVersion: rejected.version });

    const rules = staticRules(t.ctx, repo.root);

    // Included:
    expect(rules).toContain(repoApprovedAlways.rule);
    expect(rules).toContain(repoLockedAlways.rule);
    // Excluded (one assertion per required-excluded class):
    expect(rules).not.toContain(globalAlways.rule); // global always
    expect(rules).not.toContain(globalRelevant.rule); // relevant (global)
    expect(rules).not.toContain(repoRelevant.rule); // relevant (repo)
    expect(rules).not.toContain(repoConditional.rule); // conditional
    expect(rules).not.toContain(proposed.rule); // proposed
    expect(rules).not.toContain(rejected.rule); // rejected
    expect(rules).toHaveLength(2);
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("repo isolation: one repo's projection never contains another repo's rules", () => {
  const t = makeTestContext();
  const repoA = makeGitRepo("https://github.com/acme/alpha.git");
  const repoB = makeGitRepo("https://github.com/acme/beta.git");
  try {
    const a = t.ctx.repos.resolve(repoA.root)!;
    const b = t.ctx.repos.resolve(repoB.root)!;
    t.ctx.preferences.remember({ rule: "Alpha uses Bun.", scope: "repo", repoId: a.id, applicability: "always" });
    t.ctx.preferences.remember({ rule: "Beta uses pnpm.", scope: "repo", repoId: b.id, applicability: "always" });

    const rulesA = staticRules(t.ctx, repoA.root);
    const rulesB = staticRules(t.ctx, repoB.root);
    expect(rulesA).toEqual(["Alpha uses Bun."]);
    expect(rulesB).toEqual(["Beta uses pnpm."]);
  } finally {
    repoA.cleanup();
    repoB.cleanup();
    t.cleanup();
  }
});

test("conflict resolution applies to the static set (repo exclusive-domain → one winner)", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    const r = t.ctx.repos.resolve(repo.root)!;
    // Two repo-always rules in the exclusive package-manager domain → one winner.
    t.ctx.preferences.remember({ rule: "Use npm.", scope: "repo", repoId: r.id, applicability: "always", domain: "package-manager", category: "dependencies" });
    t.ctx.preferences.remember({ rule: "Use pnpm.", scope: "repo", repoId: r.id, applicability: "always", domain: "package-manager", category: "dependencies" });
    const rules = staticRules(t.ctx, repo.root);
    expect(rules).toHaveLength(1);
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("selectStaticPreferences returns the full Preference rows (with ids) for dedup", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    const r = t.ctx.repos.resolve(repo.root)!;
    const pref = t.ctx.preferences.remember({ rule: "Use Bun.", scope: "repo", repoId: r.id, applicability: "always" });
    const { preferences } = selectStaticPreferences(t.ctx, repo.root);
    expect(preferences.map((p) => p.id)).toEqual([pref.id]);
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("renderer: AGENTS block is marker-delimited; empty set renders a placeholder", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    const r = t.ctx.repos.resolve(repo.root)!;
    t.ctx.preferences.remember({ rule: "Use Bun here.", scope: "repo", repoId: r.id, applicability: "always", domain: "package-manager" });
    const block = renderAgentsBlock(buildProjection(t.ctx, repo.root));
    expect(block.startsWith(AGENTS_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(AGENTS_END)).toBe(true);
    expect(block).toContain("- [repo/package-manager] Use Bun here.");

    // No repo-always rules → placeholder, not an empty/misleading list.
    const empty = makeGitRepo("https://github.com/acme/empty.git");
    t.ctx.repos.resolve(empty.root);
    expect(renderAgentsBlock(buildProjection(t.ctx, empty.root))).toContain("no repo always-on");
    empty.cleanup();
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});
