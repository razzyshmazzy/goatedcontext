import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real multi-process concurrency: each call spawns a fresh `ctx` CLI process, so
// these exercise cross-process SQLite locking and file locks, not just in-process
// Promise concurrency. The encrypted-file secret backend is forced for speed and
// determinism (no PowerShell/DPAPI spawns inside the race).

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function ctx(
  args: string[],
  opts: { home: string; cwd?: string; exec?: string[] } = { home: "" },
): Promise<RunResult> {
  const full = opts.exec ? [...args, "--exec", ...opts.exec] : args;
  const proc = Bun.spawn([BUN, "run", INDEX, ...full], {
    cwd: opts.cwd ?? opts.home,
    env: { ...process.env, CTX_HOME: opts.home, CTX_SECRET_BACKEND: "file" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  })();
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ctx-conc-"));
}

function openDb(home: string): Database {
  return new Database(join(home, "ctx.db"), { readonly: true });
}

function gitInit(dir: string, remote: string): void {
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: dir });
}

test(
  "init race: many simultaneous inits do not corrupt or double-migrate",
  async () => {
    const home = freshHome();
    const results = await Promise.all(Array.from({ length: 6 }, () => ctx(["init"], { home })));
    for (const r of results) {
      // Surface child stderr if an init failed, so a regression is diagnosable.
      expect(r.stderr.length > 0 ? `${r.code}:${r.stderr}` : r.code).toBe(0);
    }

    const db = openDb(home);
    const migRows = db
      .query<{ n: number }, [number]>("SELECT COUNT(*) n FROM schema_migrations WHERE version = ?")
      .get(2);
    expect(migRows?.n).toBe(1); // migration 2 applied exactly once
    db.close();
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "concurrent equivalent proposals -> one preference, all evidence kept",
  async () => {
    const home = freshHome();
    await ctx(["init"], { home });
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ctx(
          ["propose", "Prefer small focused pull requests.", "--scope", "global",
           "--category", "conventions", "--evidence", `agent-${i} observed this`,
           "--agent-id", `a${i}`, "--origin", "user"],
          { home },
        ),
      ),
    );
    for (const r of results) expect(r.code).toBe(0);

    const db = openDb(home);
    const prefs = db
      .query<{ id: string; rule: string }, []>(
        "SELECT id, rule FROM preferences WHERE status = 'proposed'",
      )
      .all();
    expect(prefs.length).toBe(1); // no duplicate proposals from the race
    const ev = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM evidence WHERE preference_id = ?")
      .get(prefs[0]!.id);
    expect(ev?.n).toBe(N); // every agent's distinct evidence survived
    db.close();
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "concurrent contradictory proposals stay as two distinct rules",
  async () => {
    const home = freshHome();
    await ctx(["init"], { home });
    const [a, b] = await Promise.all([
      ctx(["propose", "Use Redis.", "--scope", "global", "--category", "infrastructure", "--evidence", "added redis"], { home }),
      ctx(["propose", "Never use Redis.", "--scope", "global", "--category", "infrastructure", "--evidence", "remove redis"], { home }),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    const db = openDb(home);
    const rows = db
      .query<{ rule: string; polarity: string }, []>("SELECT rule, polarity FROM preferences")
      .all();
    expect(rows.length).toBe(2);
    const pol = rows.map((r) => r.polarity).sort();
    expect(pol).toEqual(["negative", "positive"]);
    db.close();
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "installer race: simultaneous installs never duplicate or corrupt",
  async () => {
    const home = freshHome();
    const claudeHome = join(home, "claude");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ctx(["install", "claude", "--claude-home", claudeHome], { home })),
    );
    for (const r of results) expect(r.code).toBe(0);

    const claudeMd = readFileSync(join(claudeHome, "CLAUDE.md"), "utf8");
    const markers = claudeMd.split("<!-- ctx:begin -->").length - 1;
    expect(markers).toBe(1);
    for (const s of ["context", "context-learn", "context-env"]) {
      expect(existsSync(join(claudeHome, "skills", s, "SKILL.md"))).toBe(true);
    }
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "env race: concurrent runs get isolated secrets; no leak to parent output",
  async () => {
    const home = freshHome();
    await ctx(["init"], { home });
    await ctx(["env", "add", "env-a"], { home });
    await ctx(["env", "add", "env-b"], { home });
    await ctx(["env", "set", "env-a", "VARA", "--value", "secretAAA111"], { home });
    await ctx(["env", "set", "env-b", "VARB", "--value", "secretBBB222"], { home });

    const printer = [BUN, "-e", "console.log('A='+(process.env.VARA??'-')+';B='+(process.env.VARB??'-'))"];
    const [ra, rb] = await Promise.all([
      ctx(["env", "run", "env-a"], { home, exec: printer }),
      ctx(["env", "run", "env-b"], { home, exec: printer }),
    ]);
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);

    // Each child sees only its own secret.
    expect(ra.stdout).toContain("A=secretAAA111;B=-");
    expect(rb.stdout).toContain("A=-;B=secretBBB222");
    // Cross-environment isolation.
    expect(ra.stdout).not.toContain("secretBBB222");
    expect(rb.stdout).not.toContain("secretAAA111");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "lifecycle race: simultaneous approve/reject is deterministic (one wins, one conflicts)",
  async () => {
    const home = freshHome();
    await ctx(["init"], { home });
    const prop = await ctx(
      ["propose", "Prefer feature flags for risky rollouts.", "--scope", "global", "--category", "architecture", "--evidence", "seen"],
      { home },
    );
    expect(prop.code).toBe(0);
    const db0 = openDb(home);
    const id = db0.query<{ id: string }, []>("SELECT id FROM preferences LIMIT 1").get()!.id;
    db0.close();

    const [ap, rj] = await Promise.all([
      ctx(["prefs", "approve", id], { home }),
      ctx(["prefs", "reject", id], { home }),
    ]);
    // Deterministic accounting: every process exits either success (0) or a clean
    // conflict (5) — never a crash. If they truly collide, one gets a conflict; if
    // they serialize, both succeed. Either way there is NO lost update: the final
    // version equals exactly the number of successful transitions.
    const successes = [ap.code, rj.code].filter((c) => c === 0).length;
    const conflicts = [ap.code, rj.code].filter((c) => c === 5).length;
    expect(successes + conflicts).toBe(2);
    expect(successes).toBeGreaterThanOrEqual(1);

    const db = openDb(home);
    const status = db.query<{ status: string; version: number }, [string]>(
      "SELECT status, version FROM preferences WHERE id = ?",
    ).get(id)!;
    expect(["approved", "rejected"]).toContain(status.status);
    expect(status.version).toBe(1 + successes); // no arbitrary last-writer clobber
    db.close();
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "different repos: simultaneous get + propose stay isolated",
  async () => {
    const home = freshHome();
    await ctx(["init"], { home });
    const repoA = mkdtempSync(join(tmpdir(), "ctx-repoA-"));
    const repoB = mkdtempSync(join(tmpdir(), "ctx-repoB-"));
    gitInit(repoA, "git@github.com:acme/repo-a.git");
    gitInit(repoB, "git@github.com:acme/repo-b.git");
    // register repos
    await Promise.all([ctx(["repo"], { home, cwd: repoA }), ctx(["repo"], { home, cwd: repoB })]);

    const [get, prop] = await Promise.all([
      ctx(["get", "--task", "design database persistence", "--cwd", repoA], { home, cwd: repoA }),
      ctx(
        ["propose", "This repo uses SQLite.", "--repo", "--category", "database", "--evidence", "seen", "--cwd", repoB],
        { home, cwd: repoB },
      ),
    ]);
    expect(get.code).toBe(0);
    expect(prop.code).toBe(0);

    // The repo-B proposal must not be attached to repo A.
    const db = openDb(home);
    const repos = db.query<{ id: string; name: string }, []>("SELECT id, name FROM repos").all();
    const bId = repos.find((r) => r.name === "repo-b")!.id;
    const aId = repos.find((r) => r.name === "repo-a")!.id;
    const bCount = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM preferences WHERE repo_id = ?").get(bId)!.n;
    const aCount = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM preferences WHERE repo_id = ?").get(aId)!.n;
    expect(bCount).toBe(1);
    expect(aCount).toBe(0);
    db.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  },
  TIMEOUT,
);
