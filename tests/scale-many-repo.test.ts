import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import { generateDataset, bulkSeed } from "./bench/fixtures.ts";

/**
 * Many-repository isolation (0.3.0 diagnostic, CI-blocking).
 *
 * Repo-scoped retrieval must only ever see the matching repo's rows plus globals —
 * never another repo's repo-scoped preferences — regardless of how many repos and
 * preferences exist in the store.
 */

test("repo-scoped retrieval never leaks another repo's rules (10k noise, 100 repos)", () => {
  const t = makeTestContext();
  const a = makeGitRepo("https://github.com/acme/alpha.git");
  const b = makeGitRepo("https://github.com/acme/beta.git");
  try {
    // Background noise across 100 virtual repos.
    bulkSeed(t.ctx.db, generateDataset(10_000, { seed: 42, repoCount: 100 }));

    // Register the two real repos and plant a distinct repo-scoped always-rule in each.
    // Repo-scoped (rank 2) outranks global-always noise (rank 4), so it survives the
    // always cap — that is the property this test depends on.
    const repoA = t.ctx.repos.resolve(a.root)!;
    const repoB = t.ctx.repos.resolve(b.root)!;
    t.ctx.preferences.remember({ rule: "SENTINEL-ALPHA always deploy via alpha pipeline.", scope: "repo", repoId: repoA.id, applicability: "always" });
    t.ctx.preferences.remember({ rule: "SENTINEL-BETA always deploy via beta pipeline.", scope: "repo", repoId: repoB.id, applicability: "always" });

    const inA = t.ctx.retrieval.retrieve({ cwd: a.root, task: "deploy", track: false }).preferences.map((p) => p.rule);
    const inB = t.ctx.retrieval.retrieve({ cwd: b.root, task: "deploy", track: false }).preferences.map((p) => p.rule);

    expect(inA.some((r) => r.includes("SENTINEL-ALPHA"))).toBe(true);
    expect(inA.some((r) => r.includes("SENTINEL-BETA"))).toBe(false); // no cross-repo leakage
    expect(inB.some((r) => r.includes("SENTINEL-BETA"))).toBe(true);
    expect(inB.some((r) => r.includes("SENTINEL-ALPHA"))).toBe(false);
    // A repo result never contains a repo-scoped rule bound to a different repo id.
    const aRes = t.ctx.retrieval.retrieve({ cwd: a.root, task: "deploy", track: false });
    for (const p of aRes.preferences) if (p.scope === "repo") expect(p.rule).toContain("ALPHA");
  } finally {
    a.cleanup();
    b.cleanup();
    t.cleanup();
  }
});

test("in a repo context, both the repo's always-rule and a global always-rule appear (clean store)", () => {
  const t = makeTestContext();
  const a = makeGitRepo("https://github.com/acme/zeta.git");
  try {
    const repoA = t.ctx.repos.resolve(a.root)!;
    t.ctx.preferences.remember({ rule: "SENTINEL-REPO always run the repo smoke test.", scope: "repo", repoId: repoA.id, applicability: "always" });
    t.ctx.preferences.remember({ rule: "SENTINEL-GLOBAL always write a changelog entry.", scope: "global", applicability: "always" });
    const inA = t.ctx.retrieval.retrieve({ cwd: a.root, task: "anything", track: false }).preferences.map((p) => p.rule);
    expect(inA.some((r) => r.includes("SENTINEL-REPO"))).toBe(true);
    expect(inA.some((r) => r.includes("SENTINEL-GLOBAL"))).toBe(true);
  } finally {
    a.cleanup();
    t.cleanup();
  }
});

test("no-repo context (not a git dir) sees only global rules, never any repo-scoped rule", () => {
  const t = makeTestContext();
  const a = makeGitRepo("https://github.com/acme/gamma.git");
  try {
    bulkSeed(t.ctx.db, generateDataset(2_000, { seed: 43, repoCount: 50 }));
    const repoA = t.ctx.repos.resolve(a.root)!;
    t.ctx.preferences.remember({ rule: "SENTINEL-REPO always run repo hook.", scope: "repo", repoId: repoA.id, applicability: "always" });

    // A directory with no git repo → repo resolves to null.
    const got = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "anything", track: false });
    expect(got.repo).toBeNull();
    expect(got.preferences.some((p) => p.scope === "repo")).toBe(false);
    expect(got.preferences.some((p) => p.rule.includes("SENTINEL-REPO"))).toBe(false);
  } finally {
    a.cleanup();
    t.cleanup();
  }
});

test("repo isolation holds under conflicting exclusive-domain rules in different repos", () => {
  const t = makeTestContext();
  const a = makeGitRepo("https://github.com/acme/delta.git");
  const b = makeGitRepo("https://github.com/acme/epsilon.git");
  try {
    const repoA = t.ctx.repos.resolve(a.root)!;
    const repoB = t.ctx.repos.resolve(b.root)!;
    // Opposite package-manager decisions in two repos must not bleed into each other.
    t.ctx.preferences.remember({ rule: "Always use npm in this repo.", scope: "repo", repoId: repoA.id, applicability: "always", domain: "package-manager" });
    t.ctx.preferences.remember({ rule: "Always use pnpm in this repo.", scope: "repo", repoId: repoB.id, applicability: "always", domain: "package-manager" });

    const inA = t.ctx.retrieval.retrieve({ cwd: a.root, task: "install deps", track: false }).preferences.map((p) => p.rule).join(" ");
    const inB = t.ctx.retrieval.retrieve({ cwd: b.root, task: "install deps", track: false }).preferences.map((p) => p.rule).join(" ");
    // (Assert on full phrases: "pnpm" contains the substring "npm".)
    expect(inA).toContain("use npm");
    expect(inA).not.toContain("use pnpm");
    expect(inB).toContain("use pnpm");
    expect(inB).not.toContain("use npm");
  } finally {
    a.cleanup();
    b.cleanup();
    t.cleanup();
  }
});
