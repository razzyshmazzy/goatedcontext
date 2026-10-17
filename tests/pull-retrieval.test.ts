/**
 * Autonomous PULL retrieval (v1.1 pass): regression + deterministic coverage for the
 * read-time "when to retrieve" policy. These tests contain NO live model calls — they
 * assert the standing instruction, the MCP tool description, read-only semantics, the
 * push path being untouched, and the shared capability wiring (spec §12, §25).
 */
import { test, expect, describe } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import {
  PULL_POLICY_CORE,
  PULL_POLICY_VERSION,
  PULL_POLICY_EXPLICIT_COMMAND,
  PULL_POLICY_QUERY_GUIDANCE,
  renderPullGuidance,
  GET_CONTEXT_TOOL_DESCRIPTION,
  MCP_SERVER_INSTRUCTIONS,
} from "../src/core/assets/retrieval-policy.ts";
import { CTX_INSTRUCTION_BLOCK, CLAUDE_SKILLS } from "../src/adapters/claude/skills.ts";
import { renderContextBlock } from "../src/core/render/context-block.ts";
import { buildContextEnvelope } from "../src/core/agents/envelope.ts";
import { isCanonicalDomain } from "../src/core/signals/domains.ts";

const contextSkill = CLAUDE_SKILLS.find((s) => s.dir === "context")!.content;

describe("pull policy — standing instruction", () => {
  test("has a stable version marker", () => {
    expect(PULL_POLICY_VERSION).toBe("3");
  });

  test("core concept teaches the latent decision point AND both boundaries", () => {
    const c = PULL_POLICY_CORE.toLowerCase();
    // latent decision point
    expect(c).toContain("could reasonably depend on");
    expect(c).toMatch(/developer|repository/);
    // retrieve-when-relevant boundary
    expect(c).toContain("retrieve it when it was not already provided");
    // do-not-overcall boundary
    expect(c).toContain("do not retrieve for requests that clearly do not depend");
  });

  test("core concept teaches the oblique/outcome-phrased call-recognition principle", () => {
    const c = PULL_POLICY_CORE.toLowerCase();
    // an outcome-phrased request can hide a decision axis…
    expect(c).toContain("oblique");
    expect(c).toContain("outcome");
    expect(c).toContain("decision axis it implies");
    // …and the guard against over-calling on mere vagueness (spec §2, §3)
    expect(c).toContain("not whether");
    expect(c).toContain("vague");
  });

  test("rendered guidance carries the action, both example sets, and the dedup clause", () => {
    const g = renderPullGuidance({ action: 'run `ctx get`' });
    expect(g).toContain("run `ctx get`");
    expect(g).toContain("Retrieve when the task is something like:");
    expect(g).toContain("Do NOT retrieve for:");
    // example diversity (a relevant class + an irrelevant class)
    expect(g.toLowerCase()).toContain("dependency");
    expect(g.toLowerCase()).toContain("http 404");
    // push/pull dedup (spec §19)
    expect(g).toContain("already injected this turn");
    expect(g).toContain("do not re-fetch the same thing");
    // read-only framing (spec §7)
    expect(g.toLowerCase()).toContain("read-only");
    // explicit-command semantics + query construction are embedded (spec §7, §9, §10)
    expect(g).toContain(PULL_POLICY_EXPLICIT_COMMAND);
    expect(g).toContain(PULL_POLICY_QUERY_GUIDANCE);
  });

  test("explicit-command policy carries the command, previous-turn inheritance, and 'not the query' rule", () => {
    const e = PULL_POLICY_EXPLICIT_COMMAND.toLowerCase();
    // recognizes the explicit commands (spec §7)
    expect(e).toContain("ctx it");
    expect(e).toContain("check ctx");
    // the command must NOT be searched literally (spec §7, §12)
    expect(e).toContain("the command is not the query");
    expect(e).toContain('do not search for the words "ctx it"');
    // previous-turn inheritance, scoped to the one immediately-relevant request (spec §10)
    expect(e).toContain("immediately preceding unresolved request");
    expect(e).toContain("never replay the whole conversation");
    // the worked naming example (spec §12 — generic, not special-casing a literal name)
    expect(e).toContain("what do you call me");
  });

  test("query-construction policy teaches semantic expansion with intent categories, not a fixed list", () => {
    const q = PULL_POLICY_QUERY_GUIDANCE.toLowerCase();
    expect(q).toContain("semantic query");
    expect(q).toContain("not a keyword echo");
    // names intent categories as hints (spec §9, §11)
    for (const cls of ["dependency", "testing", "database", "architecture", "naming"]) {
      expect(q).toContain(cls);
    }
    // worked expansions, incl. the naming case
    expect(q).toContain("add uuid");
    expect(q).toContain("preferred name");
  });

  test("Claude global CLAUDE.md block teaches proactive pull with the CLI action", () => {
    expect(CTX_INSTRUCTION_BLOCK).toContain("ctx get --cwd");
    // still describes the PUSH path (hybrid, not a replacement — spec §2)
    expect(CTX_INSTRUCTION_BLOCK).toContain("<ctx-developer-context>");
    // latent decision point + dedup + overcall boundary
    expect(CTX_INSTRUCTION_BLOCK).toContain("could reasonably depend on");
    expect(CTX_INSTRUCTION_BLOCK).toContain("injected this turn");
    expect(CTX_INSTRUCTION_BLOCK).toContain("clearly do not depend on developer/project context");
    // explicit command + semantic-query + naming coverage (spec §7, §9, §12)
    expect(CTX_INSTRUCTION_BLOCK).toContain("ctx it");
    expect(CTX_INSTRUCTION_BLOCK).toContain("the command is not");
    expect(CTX_INSTRUCTION_BLOCK.toLowerCase()).toContain("preceding unresolved request");
    expect(CTX_INSTRUCTION_BLOCK.toLowerCase()).toContain("not a bare keyword echo");
    expect(CTX_INSTRUCTION_BLOCK.toLowerCase()).toContain("addressed");
    // the old undercall wording is gone
    expect(CTX_INSTRUCTION_BLOCK).not.toContain("normally do NOT need to call");
  });

  test("context skill embeds the shared pull guidance (single source of truth)", () => {
    expect(contextSkill).toContain("Proactive retrieval (pull)");
    expect(contextSkill).toContain(PULL_POLICY_CORE);
    expect(contextSkill).toContain("ctx get --cwd");
    // push path retained
    expect(contextSkill).toContain("Automatic retrieval (push)");
    // the old discouraging wording is gone
    expect(contextSkill).not.toContain("You normally do NOT need to call");
  });
});

describe("pull policy — MCP get_context description", () => {
  test("explains WHY to call (the latent decision point) and the boundary", () => {
    const d = GET_CONTEXT_TOOL_DESCRIPTION.toLowerCase();
    expect(d).toContain("could reasonably depend on");
    expect(d).toContain("do not call it for clearly unrelated");
    expect(d).toContain("read-only");
  });

  test("names the concrete relevant decision classes without pattern-locking", () => {
    const d = GET_CONTEXT_TOOL_DESCRIPTION.toLowerCase();
    for (const cls of ["dependencies", "testing", "persistence", "architecture"]) {
      expect(d).toContain(cls);
    }
  });

  test("exposes NO internal implementation details", () => {
    const d = GET_CONTEXT_TOOL_DESCRIPTION.toLowerCase();
    for (const leak of ["sqlite", "retrievalengine", "envelope builder", "track:", "markused", "wal"]) {
      expect(d).not.toContain(leak);
    }
  });

  test("server instructions cover pull boundary and the hard write-provenance rule", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("get_context");
    expect(MCP_SERVER_INSTRUCTIONS.toLowerCase()).toContain("could reasonably depend on");
    expect(MCP_SERVER_INSTRUCTIONS.toLowerCase()).toContain("already provided this turn");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("origin=user");
    // explicit command + semantic query (spec §7, §9)
    expect(MCP_SERVER_INSTRUCTIONS).toContain("ctx it");
    expect(MCP_SERVER_INSTRUCTIONS.toLowerCase()).toContain("not a bare keyword echo");
  });
});

describe("pull retrieval — read-only (spec §7)", () => {
  test("track:false retrieval does not mark preferences used (no write)", () => {
    const t = makeTestContext();
    try {
      const p = t.ctx.preferences.remember({
        rule: "Prefer relational constraints and database-enforced invariants.",
        category: "database",
        scope: "global",
      });
      expect(t.ctx.preferences.getById(p.id)!.lastUsedAt).toBeNull();
      // The pull path (`ctx get`, `ctx agent context`, MCP get_context) all pass track:false.
      t.ctx.retrieval.retrieve({
        cwd: process.cwd(),
        task: "Design the database schema persistence.",
        track: false,
      });
      expect(t.ctx.preferences.getById(p.id)!.lastUsedAt).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("control: default (tracked) retrieval DOES mark used — proving the test bites", () => {
    const t = makeTestContext();
    try {
      const p = t.ctx.preferences.remember({
        rule: "Prefer relational constraints and database-enforced invariants.",
        category: "database",
        scope: "global",
      });
      t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "Design the database schema persistence." });
      expect(t.ctx.preferences.getById(p.id)!.lastUsedAt).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });
});

describe("pull retrieval — push path unchanged + compact response", () => {
  test("renderContextBlock still emits the same container for a relevant preference", () => {
    const t = makeTestContext();
    try {
      t.ctx.preferences.remember({
        rule: "Prefer Bun for development.",
        scope: "global",
        applicability: "always",
      });
      const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "set up the project" });
      const block = renderContextBlock(result);
      expect(block).not.toBeNull();
      expect(block!.startsWith("<ctx-developer-context>")).toBe(true);
      expect(block!.trimEnd().endsWith("</ctx-developer-context>")).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("pull envelope carries compactness instrumentation (chars/tokens/prefs)", () => {
    const t = makeTestContext();
    try {
      t.ctx.preferences.remember({ rule: "Prefer Bun for development.", scope: "global", applicability: "always" });
      const result = t.ctx.retrieval.retrieve({
        cwd: process.cwd(),
        task: "add a dependency",
        track: false,
        explain: true,
      });
      const env = buildContextEnvelope(result, { isCanonicalDomain });
      const d = env.meta.diagnostics;
      expect(typeof d.renderedChars).toBe("number");
      expect(typeof d.approxTokens).toBe("number");
      expect(typeof d.delivered).toBe("number");
      // overflow is a boolean the consumer can trust (never a silent drop)
      expect(typeof d.overflow).toBe("boolean");
    } finally {
      t.cleanup();
    }
  });
});
