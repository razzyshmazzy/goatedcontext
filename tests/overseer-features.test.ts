import { test, expect } from "bun:test";
import { normalizeEvent } from "../src/core/overseer/event.ts";
import { extractFeatures } from "../src/core/overseer/features.ts";

function features(raw: Record<string, unknown>) {
  return extractFeatures(normalizeEvent({ host: "claude", sessionId: "s", seq: 0, ...raw }));
}

test("npm install parses executable, operation, package, and domain", () => {
  const f = features({ phase: "command", tool: "Bash", command: { executable: "npm", argv: ["install", "zod"] } });
  expect(f.executables.has("npm")).toBe(true);
  expect(f.operations.has("package_install")).toBe(true);
  expect(f.packages.has("zod")).toBe(true);
  expect(f.domains.has("package-manager")).toBe(true);
});

test("`bun run test` is a test run, NOT a package-manager decision", () => {
  const f = features({ phase: "command", tool: "Bash", command: { executable: "bun", argv: ["run", "test"] } });
  expect(f.operations.has("test_run")).toBe(true);
  expect(f.domains.has("package-manager")).toBe(false);
  expect(f.domains.has("testing")).toBe(true);
});

test("`npx jest` surfaces jest as an executable (one-off runner)", () => {
  const f = features({ phase: "command", tool: "Bash", command: { executable: "npx", argv: ["jest"] } });
  expect(f.executables.has("jest")).toBe(true);
  expect(f.operations.has("test_run")).toBe(true);
  expect(f.domains.has("package-manager")).toBe(false);
});

test("migration path yields migration artifact + database domain + migration_edit on write", () => {
  const f = features({ phase: "file_write", tool: "Edit", files: [{ path: "db/migrations/0003_users.sql" }] });
  expect(f.artifacts.has("migration")).toBe(true);
  expect(f.domains.has("database")).toBe(true);
  expect(f.operations.has("migration_edit")).toBe(true);
  expect(f.languages.has("sql")).toBe(true);
});

test("lockfile is both lockfile and generated; manifest detected", () => {
  expect(features({ phase: "file_write", tool: "Edit", files: [{ path: "bun.lock" }] }).artifacts.has("lockfile")).toBe(true);
  expect(features({ phase: "file_write", tool: "Edit", files: [{ path: "bun.lock" }] }).artifacts.has("generated")).toBe(true);
  expect(features({ phase: "file_read", tool: "Read", files: [{ path: "package.json" }] }).artifacts.has("manifest")).toBe(true);
});

test("secret token cue + logging call → log_write operation + token cue", () => {
  const f = features({ phase: "file_write", tool: "Write", files: [{ path: "src/logger.ts" }], text: "logger.info({ accessToken })" });
  expect(f.tokenCues.has("accesstoken")).toBe(true);
  expect(f.operations.has("log_write")).toBe(true);
  expect(f.artifacts.has("logger")).toBe(true);
});

test("a common file basename like index.ts does NOT infer the database domain", () => {
  const f = features({ phase: "file_read", tool: "Read", files: [{ path: "src/utils/index.ts" }] });
  expect(f.domains.has("database")).toBe(false);
});

test("flat feature tags are emitted for the inverted index", () => {
  const f = features({ phase: "command", tool: "Bash", command: { executable: "psql", argv: ["app"] } });
  expect(f.tags.has("phase:command")).toBe(true);
  expect(f.tags.has("exe:psql")).toBe(true);
  expect(f.tags.has("op:db_query")).toBe(true);
  expect(f.tags.has("domain:database")).toBe(true);
});
