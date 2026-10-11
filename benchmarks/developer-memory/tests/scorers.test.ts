import { describe, test, expect } from "bun:test";
import { score } from "../src/scorers.ts";
import type { ObservedBehavior } from "../src/schema.ts";

const b = (over: Partial<ObservedBehavior>): ObservedBehavior => ({ commands: [], files: {}, finalText: "", ...over });

describe("packageAdded", () => {
  test("passes on the right manager command", () => {
    expect(score({ kind: "packageAdded", pkg: "zod", tool: "bun" }, b({ commands: ["bun add zod"] })).pass).toBe(true);
  });
  test("fails when a different manager is used", () => {
    expect(score({ kind: "packageAdded", pkg: "zod", tool: "bun" }, b({ commands: ["npm install zod"] })).pass).toBe(false);
  });
  test("passes via lockfile + manifest evidence", () => {
    const beh = b({ files: { "bun.lock": "…", "package.json": '{ "dependencies": { "zod": "^3" } }' } });
    expect(score({ kind: "packageAdded", pkg: "zod", tool: "bun" }, beh).pass).toBe(true);
  });
  test("does NOT pass on prose claiming the package was added", () => {
    expect(score({ kind: "packageAdded", pkg: "zod", tool: "bun" }, b({ finalText: "I ran bun add zod" })).pass).toBe(false);
  });
});

describe("exactChoice", () => {
  const s = { kind: "exactChoice" as const, choice: "bun", notOneOf: ["npm", "yarn", "pnpm"] };
  test("passes on the preferred choice", () => {
    expect(score(s, b({ commands: ["bun add x"] })).pass).toBe(true);
  });
  test("fails when a rival is chosen", () => {
    expect(score(s, b({ commands: ["yarn add x"] })).pass).toBe(false);
  });
});

describe("noForbiddenChoice (abstention)", () => {
  const s = { kind: "noForbiddenChoice" as const, forbidden: ["bun add", "npm install"] };
  test("passes when the agent did nothing preference-related", () => {
    expect(score(s, b({ finalText: "TCP slow start is..." })).pass).toBe(true);
  });
  test("fails on a false-positive application", () => {
    expect(score(s, b({ commands: ["bun add left-pad"] })).pass).toBe(false);
  });
});

describe("file + framework scorers", () => {
  test("fileExtension / fileExtensionNotAnyOf", () => {
    const beh = b({ files: { "scripts/task.ts": "export {}" } });
    expect(score({ kind: "fileExtension", anyOf: ["ts"] }, beh).pass).toBe(true);
    expect(score({ kind: "fileExtensionNotAnyOf", noneOf: ["js"] }, beh).pass).toBe(true);
    const jsBeh = b({ files: { "scripts/task.js": "module.exports={}" } });
    expect(score({ kind: "fileExtensionNotAnyOf", noneOf: ["js"] }, jsBeh).pass).toBe(false);
  });
  test("frameworkDetected vitest via import", () => {
    expect(score({ kind: "frameworkDetected", framework: "vitest" }, b({ files: { "a.test.ts": "import {it} from 'vitest'" } })).pass).toBe(true);
  });
  test("frameworkDetected postgres via pg import", () => {
    expect(score({ kind: "frameworkDetected", framework: "postgres" }, b({ files: { "db.ts": "import {Client} from 'pg'" } })).pass).toBe(true);
  });
});

describe("composites", () => {
  test("all requires every child", () => {
    const beh = b({ files: { "x.ts": "import {it} from 'vitest'" } });
    const s = { kind: "all" as const, scorers: [{ kind: "frameworkDetected" as const, framework: "vitest" }, { kind: "fileExtension" as const, anyOf: ["ts"] }] };
    expect(score(s, beh).pass).toBe(true);
  });
});
