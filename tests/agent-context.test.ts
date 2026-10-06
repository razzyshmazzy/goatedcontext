import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 1 (0.4.0): the universal `ctx agent context` contract — a stable, versioned
// JSON envelope, a strict --stdin mode, and a --format text fallback. Driven through
// REAL spawned `ctx` processes so the machine contract (JSON-only stdout, diagnostics
// to stderr, nonzero exit on bad input) is tested exactly as an integrating agent sees it.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 90_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>, stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    env: { ...process.env, CTX_SECRET_BACKEND: "file", ...env },
    stdin: stdin !== undefined ? Buffer.from(stdin, "utf8") : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  })();
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-ac-"));
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ctx-ac-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

const ALWAYS = "Never add dependencies without asking.";
const REPO_RULE = "Use Bun for development commands.";

// Register the repo (a read-only `agent context` never registers a repo — the hot read
// path must not write), then seed a global-always rule. Returns once ctx has repo context.
async function seed(env: Record<string, string>, repo: string) {
  await run(["remember", "--scope", "repo", "--cwd", repo, "--always", REPO_RULE], env);
  await run(["remember", "--always", ALWAYS], env);
}

test(
  "envelope: stable v1 shape; JSON-only stdout; no internal ids/paths leaked",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await seed(env, repo);
      const res = await run(["agent", "context", "--task", "set up the project", "--cwd", repo, "--json"], env);
      expect(res.code).toBe(0);
      expect(res.stderr.trim()).toBe(""); // diagnostics never pollute machine stdout

      // The ENTIRE stdout parses as one JSON document (no human prose mixed in).
      const env1 = JSON.parse(res.stdout);
      expect(env1.version).toBe(1);
      expect(Array.isArray(env1.context.authoritativePreferences)).toBe(true);
      expect(Array.isArray(env1.context.observedPatterns)).toBe(true);
      expect(env1.context.proposals).toBeUndefined(); // proposals excluded by default (§13)

      const rules = env1.context.authoritativePreferences.map((p: { rule: string }) => p.rule);
      expect(rules).toContain(ALWAYS);
      // Preference items carry behavior only — never an internal DB id.
      for (const p of env1.context.authoritativePreferences) {
        expect(Object.keys(p).sort()).toEqual(["applicability", "confidence", "domain", "rule", "scope"]);
      }

      // meta: repo as a boolean + display name only; no cwd/path/id fields.
      expect(env1.meta.repo).toBe(true);
      expect(typeof env1.meta.repoName).toBe("string");
      expect(env1.meta).not.toHaveProperty("cwd");
      expect(Array.isArray(env1.meta.domains)).toBe(true);

      const d = env1.meta.diagnostics;
      for (const k of [
        "candidate", "effective", "delivered", "authoritative", "observedPatterns",
        "renderedChars", "approxTokens", "omittedByRelevance", "omittedByBudget", "overflow",
      ]) {
        expect(d).toHaveProperty(k);
      }
      expect(d.overflow).toBe(false); // nothing omitted here

      // Privacy: the absolute working directory never appears anywhere in the envelope.
      expect(res.stdout).not.toContain(repo);
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "observed patterns surface as NON-authoritative evidence for a matching task",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await run(["signal", "add", "--domain", "database", "--choice", "postgres", "--cwd", repo], env);
      const res = await run(["agent", "context", "--task", "what database should I use?", "--cwd", repo, "--json"], env);
      expect(res.code).toBe(0);
      const e = JSON.parse(res.stdout);
      const dbPattern = e.context.observedPatterns.find((p: { domain: string }) => p.domain === "database");
      expect(dbPattern).toBeTruthy();
      // Evidence is never promoted into authoritative preferences.
      expect(e.context.authoritativePreferences).toEqual([]);
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "--stdin: strict JSON object is accepted; same envelope as flags",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await seed(env, repo);
      const payload = JSON.stringify({ task: "set up the backend", cwd: repo });
      const res = await run(["agent", "context", "--stdin", "--json"], env, payload);
      expect(res.code).toBe(0);
      const e = JSON.parse(res.stdout);
      expect(e.version).toBe(1);
      expect(e.meta.repo).toBe(true);
      expect(e.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).toContain(ALWAYS);
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "--stdin: unknown key is rejected (strict) with a nonzero exit and stderr diagnostic",
  async () => {
    const h = home();
    const env = { CTX_HOME: h };
    try {
      const payload = JSON.stringify({ task: "x", danger: "rm -rf" });
      const res = await run(["agent", "context", "--stdin", "--json"], env, payload);
      expect(res.code).not.toBe(0);
      expect(res.stdout.trim()).toBe(""); // no partial/garbage JSON on failure
      expect(res.stderr.toLowerCase()).toContain("error");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "--stdin: non-JSON input fails closed with a clear error (no eval, no crash)",
  async () => {
    const h = home();
    const env = { CTX_HOME: h };
    try {
      const res = await run(["agent", "context", "--stdin", "--json"], env, "not json at all");
      expect(res.code).not.toBe(0);
      expect(res.stdout.trim()).toBe("");
      expect(res.stderr.toLowerCase()).toContain("json");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "--format text renders the canonical block (not JSON); semantically sourced from the same result",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await run(["remember", "--always", ALWAYS], env);

      const textRes = await run(["agent", "context", "--task", "do work", "--cwd", repo, "--format", "text"], env);
      expect(textRes.code).toBe(0);
      expect(textRes.stdout).toContain("<ctx-developer-context>");
      expect(textRes.stdout).toContain(ALWAYS);
      expect(() => JSON.parse(textRes.stdout)).toThrow(); // text mode is NOT JSON

      // Parity (amendment 15): the JSON envelope's authoritative rules match the text block's.
      const jsonRes = await run(["agent", "context", "--task", "do work", "--cwd", repo, "--json"], env);
      const e = JSON.parse(jsonRes.stdout);
      for (const p of e.context.authoritativePreferences) {
        expect(textRes.stdout).toContain(p.rule);
      }
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "proposals: excluded by default; included and flagged non-authoritative with --include-proposed",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      // A proposed (needs-review) preference — never authoritative. `--always` so it is
      // delivered irrespective of task relevance, keeping the assertion deterministic.
      await run(
        ["propose", "Prefer pnpm for installs.", "--scope", "global", "--always", "--evidence", "seen twice"],
        env,
      );

      const def = JSON.parse(
        (await run(["agent", "context", "--task", "install deps", "--cwd", repo, "--json"], env)).stdout,
      );
      expect(def.context.proposals).toBeUndefined();
      expect(def.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).not.toContain(
        "Prefer pnpm for installs.",
      );

      const inc = JSON.parse(
        (await run(
          ["agent", "context", "--task", "install deps", "--cwd", repo, "--include-proposed", "--json"],
          env,
        )).stdout,
      );
      expect(Array.isArray(inc.context.proposals)).toBe(true);
      const prop = inc.context.proposals.find((p: { rule: string }) => p.rule === "Prefer pnpm for installs.");
      expect(prop).toBeTruthy();
      expect(prop.authoritative).toBe(false);
      // It must NOT have leaked into the authoritative set.
      expect(inc.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).not.toContain(
        "Prefer pnpm for installs.",
      );
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "explicit budget reports overflow instead of silently dropping (authoritative never lost silently)",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      // Two independent always rules (distinct subjects → no conflict merge); a tiny
      // budget forces exactly one to be omitted-by-budget, surfaced not silently dropped.
      await run(["remember", "--always", "Never add dependencies without asking."], env);
      await run(["remember", "--always", "Write tests for every new function."], env);
      const res = await run(
        ["agent", "context", "--task", "do some work", "--cwd", repo, "--budget-prefs", "1", "--json"],
        env,
      );
      expect(res.code).toBe(0);
      const e = JSON.parse(res.stdout);
      // Overflow is surfaced; the omission is observable, never silent.
      expect(e.meta.diagnostics.overflow).toBe(true);
      expect(e.meta.diagnostics.omittedByBudget).toBeGreaterThan(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
