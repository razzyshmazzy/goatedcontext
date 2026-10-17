import { test, expect } from "bun:test";
import { normalizeEvent, isAgentEvent, AgentEventSchema, MAX_EVENT_TEXT } from "../src/core/overseer/event.ts";

test("normalizeEvent normalizes backslash paths and lowercases extensions", () => {
  const e = normalizeEvent({
    host: "claude",
    sessionId: "s1",
    seq: 0,
    phase: "file_write",
    tool: "Edit",
    files: [{ path: "src\\Auth\\Login.TS" }],
  });
  expect(e.files?.[0]?.path).toBe("src/Auth/Login.TS");
  expect(e.files?.[0]?.extension).toBe("ts");
});

test("normalizeEvent bounds observational text", () => {
  const long = "x".repeat(MAX_EVENT_TEXT + 500);
  const e = normalizeEvent({ host: "claude", sessionId: "s", seq: 1, phase: "command", text: long });
  expect(e.text?.length).toBe(MAX_EVENT_TEXT);
});

test("malformed events are rejected (unknown host / phase / negative seq)", () => {
  expect(isAgentEvent({ host: "vim", sessionId: "s", seq: 0, phase: "prompt" })).toBe(false);
  expect(isAgentEvent({ host: "claude", sessionId: "s", seq: 0, phase: "explode" })).toBe(false);
  expect(isAgentEvent({ host: "claude", sessionId: "s", seq: -1, phase: "prompt" })).toBe(false);
  expect(() => normalizeEvent({ host: "claude" })).toThrow();
});

test("a valid minimal event round-trips", () => {
  const raw = { host: "claude", sessionId: "s", seq: 3, phase: "stop" };
  expect(AgentEventSchema.safeParse(raw).success).toBe(true);
  const e = normalizeEvent(raw);
  expect(e.phase).toBe("stop");
  expect(e.seq).toBe(3);
});

test("extra/unknown top-level keys are rejected (strict schema)", () => {
  expect(isAgentEvent({ host: "claude", sessionId: "s", seq: 0, phase: "prompt", bogus: 1 })).toBe(false);
});
