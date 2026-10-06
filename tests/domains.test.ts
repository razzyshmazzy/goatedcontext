import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_DOMAINS,
  DOMAIN_ALIASES,
  canonicalDomain,
  classifyDomain,
  isCanonicalDomain,
} from "../src/core/signals/domains.ts";
import { KNOWN_DOMAINS } from "../src/core/preferences/analysis.ts";
import { makeTestContext } from "./helpers.ts";

// Phase 2 (0.4.0): canonical decision domains as RECOMMENDED vocabulary — never a
// closed ontology. domain = decision CATEGORY, choice = technology. Unknown domains
// stay valid. The agent classifies semantically at write time; core only normalizes.

test("invariant: the canonical set never drifts from the classifier + alias layer", () => {
  // Every domain the task classifier recognizes canonicalizes INTO the canonical set,
  // and every alias target IS canonical — so `CANONICAL_DOMAINS` can't silently diverge
  // from what ctx actually surfaces.
  for (const d of KNOWN_DOMAINS) {
    expect(CANONICAL_DOMAINS.has(canonicalDomain(d))).toBe(true);
  }
  for (const target of Object.values(DOMAIN_ALIASES)) {
    expect(CANONICAL_DOMAINS.has(target)).toBe(true);
  }
});

test("classifyDomain: canonical vocabulary (incl. aliases + normalization)", () => {
  expect(classifyDomain("database")).toEqual({ domain: "database", canonical: true });
  expect(classifyDomain("db")).toEqual({ domain: "database", canonical: true }); // alias
  expect(classifyDomain("  DataBases ")).toEqual({ domain: "database", canonical: true }); // normalize
  expect(classifyDomain("ui-framework")).toEqual({ domain: "frontend", canonical: true });
  expect(classifyDomain("server")).toEqual({ domain: "backend", canonical: true });
  expect(isCanonicalDomain("package_manager")).toBe(true);
});

test("E: a technology/choice is never a canonical DOMAIN", () => {
  // The happy path puts the technology in `choice`, not `domain`. "postgres" is a choice,
  // so as a domain it is merely a (valid) CUSTOM domain, never canonical.
  expect(classifyDomain("postgres")).toEqual({ domain: "postgres", canonical: false });
  expect(isCanonicalDomain("postgres")).toBe(false);
});

test("custom domains stay valid; the alias layer is literal, never semantic (D + §27)", () => {
  // A genuinely novel category is accepted as a custom domain (forward compatibility).
  expect(classifyDomain("robotics-control")).toEqual({ domain: "robotics-control", canonical: false });
  // "data-layer" is NOT heuristically rewritten to "database" — aliases are literal string
  // equality only, so distinct spellings are never silently merged.
  expect(classifyDomain("data-layer")).toEqual({ domain: "data-layer", canonical: false });
  expect(canonicalDomain("data-layer")).not.toBe("database");
  // Two genuinely different canonical domains are never merged.
  expect(classifyDomain("database").domain).not.toBe(classifyDomain("backend").domain);
});

test("A: signal domain=db choice=postgres surfaces for a database task", () => {
  const t = makeTestContext();
  try {
    t.ctx.signals.add({ domain: "db", choice: "postgres", origin: "user" });
    const result = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "what database should I use?" });
    const patterns = result.observedPatterns ?? [];
    // The aliased signal surfaces under the canonical database domain.
    const hit = patterns.find((p) =>
      p.choices.some((c) => c.label.toLowerCase().includes("postgres")),
    );
    expect(hit).toBeTruthy();
  } finally {
    t.cleanup();
  }
});

test("B: a canonical database/postgres decision surfaces for a later database question", () => {
  const t = makeTestContext();
  try {
    // An agent records the decision under the canonical category (domain) + technology (choice).
    t.ctx.signals.add({ domain: "database", choice: "postgres", origin: "user" });
    const result = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "pick a database for this service" });
    const patterns = result.observedPatterns ?? [];
    expect(patterns.some((p) => p.domain === "database")).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("C: a custom domain is retrievable when a task explicitly matches it", () => {
  const t = makeTestContext();
  try {
    t.ctx.signals.add({ domain: "shader-toolchain", choice: "glslang", origin: "user" });
    // Not inferable from free text, but an explicit domain override matches it verbatim.
    const result = t.ctx.retrieval.retrieve({
      cwd: t.dir,
      task: "configure the build",
      domain: "shader-toolchain",
    });
    const patterns = result.observedPatterns ?? [];
    expect(patterns.some((p) => p.choices.some((c) => c.label.toLowerCase().includes("glslang")))).toBe(true);
  } finally {
    t.cleanup();
  }
});

// ---- `ctx domains` inspection command ---------------------------------------

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function run(args: string[], env: Record<string, string>): { code: number; stdout: string } {
  const out = execFileSync(BUN, ["run", INDEX, ...args], {
    env: { ...process.env, CTX_SECRET_BACKEND: "file", ...env },
    encoding: "utf8",
  });
  return { code: 0, stdout: out };
}

test(
  "ctx domains --json lists canonical vocab, aliases, and observed custom domains",
  () => {
    const h = mkdtempSync(join(tmpdir(), "ctx-dom-"));
    const env = { CTX_HOME: h };
    try {
      run(["signal", "add", "--domain", "db", "--choice", "postgres", "--no-repo"], env);
      run(["signal", "add", "--domain", "robotics-control", "--choice", "ros2", "--no-repo"], env);
      const json = JSON.parse(run(["domains", "--json"], env).stdout);
      expect(json.canonical).toContain("database");
      expect(json.canonical).toContain("backend");
      expect(json.aliases.db).toBe("database");
      expect(json.observed.canonical).toContain("database"); // db → database
      expect(json.observed.custom).toContain("robotics-control");
      expect(json.observed.canonical).not.toContain("robotics-control");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);
