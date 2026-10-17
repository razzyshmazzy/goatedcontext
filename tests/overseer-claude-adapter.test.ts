import { test, expect } from "bun:test";
import {
  claudeEventToAgentEvent,
  pickPrimarySegment,
  tokenizeCommand,
} from "../src/adapters/claude/overseer-hook.ts";

test("tokenizeCommand honors quotes", () => {
  expect(tokenizeCommand(`npm install "left pad"`)).toEqual(["npm", "install", "left pad"]);
  expect(tokenizeCommand("git commit -m 'fix bug'")).toEqual(["git", "commit", "-m", "fix bug"]);
});

test("pickPrimarySegment selects the recognized tool in a compound command", () => {
  expect(pickPrimarySegment("cd app && npm install zod")).toEqual({ executable: "npm", argv: ["install", "zod"] });
  expect(pickPrimarySegment("NODE_ENV=prod bun run build")).toEqual({ executable: "bun", argv: ["run", "build"] });
  expect(pickPrimarySegment("sudo psql app")).toEqual({ executable: "psql", argv: ["app"] });
});

test("pickPrimarySegment falls back to the first segment when nothing is recognized", () => {
  expect(pickPrimarySegment("echo hi && ls")).toEqual({ executable: "echo", argv: ["hi"] });
});

test("Bash PreToolUse payload → command AgentEvent", () => {
  const e = claudeEventToAgentEvent(
    { session_id: "abc", cwd: "/repo", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm install zod" } },
    0,
  );
  expect(e?.phase).toBe("command");
  expect(e?.command?.executable).toBe("npm");
  expect(e?.command?.argv).toEqual(["install", "zod"]);
  expect(e?.text).toBe("npm install zod");
});

test("Edit payload → file_write AgentEvent with path + snippet", () => {
  const e = claudeEventToAgentEvent(
    { session_id: "s", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/logger.ts", new_string: "logger.info({ accessToken })" } },
    2,
  );
  expect(e?.phase).toBe("file_write");
  expect(e?.files?.[0]?.path).toBe("src/logger.ts");
  expect(e?.text).toContain("accessToken");
});

test("Read maps to file_read; Stop/PreCompact map to lifecycle phases", () => {
  expect(claudeEventToAgentEvent({ session_id: "s", tool_name: "Read", tool_input: { file_path: "a.ts" }, hook_event_name: "PreToolUse" }, 0)?.phase).toBe("file_read");
  expect(claudeEventToAgentEvent({ session_id: "s", hook_event_name: "Stop" }, 9)?.phase).toBe("stop");
  expect(claudeEventToAgentEvent({ session_id: "s", hook_event_name: "PreCompact" }, 9)?.phase).toBe("compact");
});

test("missing session id falls back to 'unknown'; garbage never throws", () => {
  expect(claudeEventToAgentEvent({ hook_event_name: "Stop" }, 0)?.sessionId).toBe("unknown");
  // A wildly malformed payload yields null, never a throw.
  expect(claudeEventToAgentEvent({ tool_name: 123 as unknown as string }, 0)).not.toBeUndefined();
});
