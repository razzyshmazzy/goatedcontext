import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConflicts } from "../src/core/preferences/conflicts.ts";
import type { Preference, Status, Scope, Polarity } from "../src/core/preferences/types.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

let counter = 0;
function pref(p: {
  rule: string;
  domain: string | null;
  scope: Scope;
  status: Status;
  polarity?: Polarity;
}): Preference {
  counter += 1;
  return {
    id: `id-${counter}-abcdef`,
    rule: p.rule,
    category: p.domain ?? "general",
    domain: p.domain,
    polarity: p.polarity ?? "positive",
    scope: p.scope,
    repoId: p.scope === "repo" ? "repo-1" : null,
    status: p.status,
    applicability: "relevant",
    confidence: 1,
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    lastUsedAt: null,
  };
}

// ---- findConflicts (unit) ---------------------------------------------------

test("two approved rules in an exclusive domain are a conflict with one applying", () => {
  const a = pref({ rule: "Prefer pnpm.", domain: "package-manager", scope: "global", status: "approved" });
  const b = pref({ rule: "Use npm here.", domain: "package-manager", scope: "repo", status: "approved" });
  const conflicts = findConflicts([a, b]);
  expect(conflicts).toHaveLength(1);
  const c = conflicts[0]!;
  expect(c.kind).toBe("exclusive-domain");
  expect(c.domain).toBe("package-manager");
  expect(c.ambiguous).toBe(false);
  // Repo approved (rank 2) outranks global approved (rank 4).
  expect(c.members.find((m) => m.id === b.id)!.applies).toBe(true);
  expect(c.members.find((m) => m.id === a.id)!.applies).toBe(false);
});

test("locked global vs locked repo in the same domain conflict; repo applies", () => {
  const g = pref({ rule: "Global locked.", domain: "database", scope: "global", status: "locked" });
  const r = pref({ rule: "Repo locked.", domain: "database", scope: "repo", status: "locked" });
  const conflicts = findConflicts([g, r]);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]!.ambiguous).toBe(false);
  expect(conflicts[0]!.members.find((m) => m.id === r.id)!.applies).toBe(true);
});

test("two same-scope same-status exclusive rules are ambiguous (no clear winner)", () => {
  const a = pref({ rule: "Prefer pnpm.", domain: "package-manager", scope: "global", status: "approved" });
  const b = pref({ rule: "Prefer yarn.", domain: "package-manager", scope: "global", status: "approved" });
  const conflicts = findConflicts([a, b]);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]!.ambiguous).toBe(true);
  expect(conflicts[0]!.members.every((m) => m.applies === false)).toBe(true);
});

test("same subject with opposing polarity is flagged as a contradiction", () => {
  const pos = pref({ rule: "Use snapshot testing.", domain: "testing", scope: "global", status: "approved", polarity: "positive" });
  const neg = pref({ rule: "Never use snapshot testing.", domain: "testing", scope: "repo", status: "approved", polarity: "negative" });
  const conflicts = findConflicts([pos, neg]);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]!.kind).toBe("same-subject");
  expect(conflicts[0]!.reason).toContain("opposing polarity");
});

test("distinct subjects in a non-exclusive domain do NOT conflict", () => {
  const t1 = pref({ rule: "Prefer unit tests for logic.", domain: "testing", scope: "global", status: "approved" });
  const t2 = pref({ rule: "Prefer integration tests for APIs.", domain: "testing", scope: "global", status: "approved" });
  expect(findConflicts([t1, t2])).toHaveLength(0);
});

test("proposed/rejected preferences are never considered conflicts", () => {
  const approved = pref({ rule: "Prefer pnpm.", domain: "package-manager", scope: "global", status: "approved" });
  const proposed = pref({ rule: "Use npm.", domain: "package-manager", scope: "global", status: "proposed" });
  const rejected = pref({ rule: "Use yarn.", domain: "package-manager", scope: "global", status: "rejected" });
  expect(findConflicts([approved, proposed, rejected])).toHaveLength(0);
});

// ---- CLI ---------------------------------------------------------------------

function seededHome(fn: (p: PreferenceService) => void): string {
  const home = mkdtempSync(join(tmpdir(), "ctx-conflicts-"));
  const db = openDatabase(resolvePaths({ CTX_HOME: home }));
  try {
    fn(new PreferenceService(db));
  } finally {
    db.close();
  }
  return home;
}

async function runCli(home: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

test(
  "conflicts --global --json reports an exclusive-domain conflict",
  async () => {
    const home = seededHome((p) => {
      p.remember({ rule: "Prefer pnpm for packages.", category: "dependencies", domain: "package-manager", scope: "global" });
      p.remember({ rule: "Prefer yarn for packages.", category: "dependencies", domain: "package-manager", scope: "global" });
    });
    const { code, out } = await runCli(home, ["conflicts", "--global", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(1);
    expect(parsed.conflicts[0].kind).toBe("exclusive-domain");
    expect(parsed.conflicts[0].ambiguous).toBe(true);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "conflicts --json reports no conflicts when preferences are compatible",
  async () => {
    const home = seededHome((p) => {
      p.remember({ rule: "Write focused unit tests.", category: "testing", scope: "global" });
      p.remember({ rule: "Prefer PostgreSQL.", category: "database", domain: "database", scope: "global" });
    });
    const { code, out } = await runCli(home, ["conflicts", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(0);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "conflicts --repo errors cleanly when not inside a git repository",
  async () => {
    const home = seededHome(() => {});
    const outside = mkdtempSync(join(tmpdir(), "ctx-conflicts-norepo-"));
    const { code } = await runCli(home, ["conflicts", "--repo", "--cwd", outside]);
    expect(code).not.toBe(0);
    rmSync(outside, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
