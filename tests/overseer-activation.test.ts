import { test, expect } from "bun:test";
import { normalizeEvent } from "../src/core/overseer/event.ts";
import { extractFeatures } from "../src/core/overseer/features.ts";
import { matchActivation, parseActivationSpec, unknownVocabTerms, type ActivationSpec } from "../src/core/overseer/activation.ts";

function match(spec: ActivationSpec, raw: Record<string, unknown>) {
  return matchActivation(spec, extractFeatures(normalizeEvent({ host: "claude", sessionId: "s", seq: 0, ...raw })));
}

const bun: ActivationSpec = {
  domains: ["package-manager"],
  operations: ["package_install", "package_remove"],
  conflicts: [{ executables: ["npm", "yarn", "pnpm"] }],
};

test("relevance and conflict are computed separately", () => {
  // read package.json → relevant, not conflict
  const r = match({ ...bun, files: ["package.json"] }, { phase: "file_read", tool: "Read", files: [{ path: "package.json" }] });
  expect(r.state).toBe("relevant");

  // bun add → relevant (preferred manager, no conflict)
  const ok = match(bun, { phase: "command", tool: "Bash", command: { executable: "bun", argv: ["add", "zod"] } });
  expect(ok.state).toBe("relevant");

  // npm install → conflict
  const bad = match(bun, { phase: "command", tool: "Bash", command: { executable: "npm", argv: ["install", "zod"] } });
  expect(bad.state).toBe("conflict");
});

test("irrelevant when no dimension matches", () => {
  const r = match(bun, { phase: "file_read", tool: "Read", files: [{ path: "README.md" }] });
  expect(r.state).toBe("irrelevant");
});

test("`unless` suppresses a conflict for the preferred alternative", () => {
  const spec: ActivationSpec = {
    operations: ["package_install"],
    conflicts: [{ operations: ["package_install"], unless: { executables: ["bun", "bunx"] } }],
  };
  expect(match(spec, { phase: "command", command: { executable: "npm", argv: ["install", "x"] } }).state).toBe("conflict");
  expect(match(spec, { phase: "command", command: { executable: "bun", argv: ["add", "x"] } }).state).toBe("relevant");
});

test("token-cue conflict needs BOTH the log operation and the cue", () => {
  const spec: ActivationSpec = { artifacts: ["logger"], conflicts: [{ operations: ["log_write"], tokens: ["accesstoken"] }] };
  const conflict = match(spec, { phase: "file_write", tool: "Write", files: [{ path: "src/logger.ts" }], text: "logger.info({ accessToken })" });
  expect(conflict.state).toBe("conflict");
  const benign = match(spec, { phase: "file_write", tool: "Write", files: [{ path: "src/logger.ts" }], text: "logger.info({ userId })" });
  expect(benign.state).toBe("relevant"); // relevant (logger artifact) but not a conflict
});

test("file globs match case-insensitively", () => {
  const spec: ActivationSpec = { conflicts: [{ files: ["**/components/**/*auth*"] }] };
  expect(match(spec, { phase: "file_write", tool: "Edit", files: [{ path: "src/components/AuthForm.tsx" }] }).state).toBe("conflict");
});

test("package conflict triggers on a competing-library install", () => {
  const spec: ActivationSpec = { packages: ["bullmq"], conflicts: [{ packages: ["agenda"] }] };
  expect(match(spec, { phase: "command", command: { executable: "npm", argv: ["install", "agenda"] } }).state).toBe("conflict");
  expect(match(spec, { phase: "command", command: { executable: "bun", argv: ["add", "bullmq"] } }).state).toBe("relevant");
});

test("an empty conflict trigger never fires", () => {
  const spec = { conflicts: [{}] } as unknown as ActivationSpec;
  expect(match(spec, { phase: "command", command: { executable: "npm", argv: ["install", "x"] } }).state).toBe("irrelevant");
});

test("parseActivationSpec rejects unknown keys; unknownVocabTerms flags bad vocab", () => {
  expect(() => parseActivationSpec({ bogus: true })).toThrow();
  expect(unknownVocabTerms({ operations: ["teleport"], artifacts: ["unicorn"] })).toEqual(["operation:teleport", "artifact:unicorn"]);
  expect(unknownVocabTerms({ operations: ["test_run"], artifacts: ["migration"] })).toEqual([]);
});
