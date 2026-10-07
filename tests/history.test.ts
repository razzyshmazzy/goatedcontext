import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

// ---- event recording (unit) -------------------------------------------------

test("remember records a 'remembered' event", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Prefer pnpm for packages.",
    category: "dependencies",
    scope: "global",
  });
  const events = t.ctx.events.list();
  expect(events).toHaveLength(1);
  expect(events[0]!.type).toBe("preference.remembered");
  expect(events[0]!.preferenceId).toBe(p.id);
  expect(events[0]!.summary).toBe("Prefer pnpm for packages.");
  t.cleanup();
});

test("propose then approve records proposed + approved, most-recent-first", () => {
  const t = makeTestContext();
  const { preference } = t.ctx.preferences.propose({
    rule: "Prefer functional core, imperative shell.",
    category: "architecture",
    scope: "global",
    evidence: "seen repeatedly",
  });
  t.ctx.preferences.approve(preference.id);
  const events = t.ctx.events.list();
  expect(events.map((e) => e.type)).toEqual([
    "preference.approved",
    "preference.proposed",
  ]);
  t.cleanup();
});

test("approving a locked preference is a no-op (never silently unlocks)", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Use PostgreSQL.",
    category: "database",
    scope: "global",
    status: "locked",
  });
  const after = t.ctx.preferences.approve(p.id);
  expect(after.status).toBe("locked"); // NOT downgraded to approved
  expect(after.version).toBe(p.version); // no write happened
  // No spurious unlock/approve event was recorded by the no-op.
  const types = t.ctx.events.list().map((e) => e.type);
  expect(types).not.toContain("preference.unlocked");
  t.cleanup();
});

test("forget records a 'forgotten' event that survives deletion of the preference", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Prefer pnpm for packages.",
    category: "dependencies",
    scope: "global",
  });
  t.ctx.preferences.forget(p.id);
  expect(t.ctx.preferences.getById(p.id)).toBeNull();
  const forgotten = t.ctx.events.list().find((e) => e.type === "preference.forgotten");
  expect(forgotten).toBeDefined();
  expect(forgotten!.preferenceId).toBe(p.id); // audit still references the (now deleted) id
  expect(forgotten!.summary).toBe("Prefer pnpm for packages.");
  t.cleanup();
});

test("environment add/remove are recorded and never expose secret values", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "supabase-test" });
  const secret = "FAKE_SECRET_sb_zzz_123";
  t.ctx.environments.setVariable(env.id, "SUPABASE_ANON_KEY", secret);
  t.ctx.environments.remove(env);
  const events = t.ctx.events.list();
  const types = events.map((e) => e.type);
  expect(types).toContain("environment.created");
  expect(types).toContain("environment.removed");
  expect(JSON.stringify(events)).not.toContain(secret);
  t.cleanup();
});

test("provenance (agent/session) is captured on events", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer parameterized SQL.",
    category: "security",
    scope: "global",
    agentId: "claude-code",
    sessionId: "sess-1",
  });
  const e = t.ctx.events.list()[0]!;
  expect(e.agentId).toBe("claude-code");
  expect(e.sessionId).toBe("sess-1");
  t.cleanup();
});

test("list respects the limit and repo filter", () => {
  const t = makeTestContext();
  for (let i = 0; i < 5; i++) {
    t.ctx.preferences.remember({ rule: `Global rule ${i} about testing.`, category: "testing", scope: "global" });
  }
  expect(t.ctx.events.list({ limit: 3 })).toHaveLength(3);
  // No repo-scoped events yet → repo filter returns nothing.
  expect(t.ctx.events.list({ repoId: "repo-xyz" })).toHaveLength(0);
  t.cleanup();
});

// ---- CLI --------------------------------------------------------------------

function seededHome(fn: (p: PreferenceService) => void): string {
  const home = mkdtempSync(join(tmpdir(), "ctx-history-"));
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
  "history --json emits events most-recent-first",
  async () => {
    const home = seededHome((p) => {
      p.remember({ rule: "First rule about testing.", category: "testing", scope: "global" });
      p.remember({ rule: "Second rule about databases.", category: "database", scope: "global" });
    });
    const { code, out } = await runCli(home, ["history", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].summary).toBe("Second rule about databases.");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "history --limit caps the number of events",
  async () => {
    const home = seededHome((p) => {
      for (let i = 0; i < 4; i++) {
        p.remember({ rule: `Rule ${i} about testing.`, category: "testing", scope: "global" });
      }
    });
    const { code, out } = await runCli(home, ["history", "--limit", "2", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out).length).toBe(2);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "history with no events prints a friendly message",
  async () => {
    const home = seededHome(() => {});
    const { code, out } = await runCli(home, ["history"]);
    expect(code).toBe(0);
    expect(out).toContain("No history yet.");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "history --repo errors cleanly when not inside a git repository",
  async () => {
    const home = seededHome(() => {});
    const outside = mkdtempSync(join(tmpdir(), "ctx-history-norepo-"));
    const { code } = await runCli(home, ["history", "--repo", "--cwd", outside]);
    expect(code).not.toBe(0);
    rmSync(outside, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
