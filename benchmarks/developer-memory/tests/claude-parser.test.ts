/**
 * Regression test for the Claude-headless stream-json parser (spec §5), pinned against a
 * REAL captured transcript (fixtures/claude-stream-sample.jsonl) from Claude Code 2.1.181.
 * The sample run: "create src/hello.ts and add the zod dependency" → one Write and one Bash
 * tool_use, plus thinking/text/tool_result/system events and a final result/success.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStream } from "../src/adapters/claude-headless.ts";

const SAMPLE = readFileSync(join(import.meta.dir, "fixtures", "claude-stream-sample.jsonl"), "utf8");

describe("claude stream-json parser", () => {
  const { behavior, meta } = parseStream(SAMPLE, "C:/Users/Admin/AppData/Local/Temp/tmp.diWauVf4wH/repo");

  test("captures the Bash command (shell tool_use)", () => {
    expect(behavior.commands.some((c) => /npm install zod/.test(c))).toBe(true);
  });

  test("captures the Write file + contents", () => {
    const hello = Object.entries(behavior.files).find(([p]) => p.endsWith("hello.ts"));
    expect(hello).toBeDefined();
    expect(hello![1]).toContain("greeting");
  });

  test("captures the final result text (not thinking)", () => {
    expect(behavior.finalText.toLowerCase()).toContain("done");
  });

  test("extracts run metadata from the result event", () => {
    expect(typeof meta.sessionId).toBe("string");
    expect(meta.sessionId!.length).toBeGreaterThan(0);
    expect(typeof meta.costUsd).toBe("number");
    expect(meta.permissionDenials).toBe(0); // bypassPermissions → no denials
    expect(meta.isError).toBe(false);
    expect((meta.numTurns ?? 0)).toBeGreaterThan(0);
  });

  test("ignores thinking blocks and system/rate_limit events without throwing", () => {
    // The sample contains thinking, system/*, rate_limit_event, tool_result — none should
    // leak into commands/files, and parsing must not throw on any line.
    expect(behavior.commands.every((c) => typeof c === "string")).toBe(true);
    expect(() => parseStream(SAMPLE + "\n{bad json\n", "/x")).not.toThrow();
  });
});

describe("claude parser — Windows PowerShell tool (regression for the pilot parser gap)", () => {
  // On Windows Claude Code runs shell commands via a `PowerShell` tool (input.command),
  // NOT `Bash`. The first pilot proved the earlier Bash-only parser dropped these. This
  // fixture is a real transcript where the model ran `npm install zod` via PowerShell.
  const PS = readFileSync(join(import.meta.dir, "fixtures", "claude-stream-powershell.jsonl"), "utf8");
  test("captures a PowerShell shell command", () => {
    const { behavior } = parseStream(PS, "C:/x");
    expect(behavior.commands.some((c) => /npm install zod/.test(c))).toBe(true);
  });
});
