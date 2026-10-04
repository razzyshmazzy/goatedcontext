import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
} from "../src/utils/managed-block.ts";

const B = "<!-- gc:begin -->";
const E = "<!-- gc:end -->";
const block = (body: string) => `${B}\n${body}\n${E}`;

function tmpFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-mb-"));
  return { file: join(dir, "AGENTS.md"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("creates the file + block when absent", () => {
  const { file, cleanup } = tmpFile();
  expect(upsertManagedBlock(file, B, E, block("one"))).toBe("created");
  expect(readFileSync(file, "utf8")).toContain("one");
  expect(hasManagedBlock(file, B, E)).toBe(true);
  cleanup();
});

test("refreshes in place and is idempotent, preserving surrounding content", () => {
  const { file, cleanup } = tmpFile();
  writeFileSync(file, `# My project\n\nIntro text.\n\n${block("v1")}\n\n## Footer\n`);
  expect(upsertManagedBlock(file, B, E, block("v2"))).toBe("updated");
  const after = readFileSync(file, "utf8");
  expect(after).toContain("# My project");
  expect(after).toContain("## Footer");
  expect(after).toContain("v2");
  expect(after).not.toContain("v1");
  expect(upsertManagedBlock(file, B, E, block("v2"))).toBe("unchanged");
  cleanup();
});

test("dedupes stray duplicate blocks down to one", () => {
  const { file, cleanup } = tmpFile();
  writeFileSync(file, `${block("a")}\n\nmiddle\n\n${block("b")}\n`);
  upsertManagedBlock(file, B, E, block("c"));
  const after = readFileSync(file, "utf8");
  expect(after.match(/gc:begin/g)!.length).toBe(1);
  expect(after).toContain("middle");
  expect(after).toContain("c");
  cleanup();
});

test("tolerates a damaged block (missing end marker)", () => {
  const { file, cleanup } = tmpFile();
  writeFileSync(file, `keep me\n\n${B}\nhalf written`);
  upsertManagedBlock(file, B, E, block("fixed"));
  const after = readFileSync(file, "utf8");
  expect(after).toContain("keep me");
  expect(after).toContain("fixed");
  expect(hasManagedBlock(file, B, E)).toBe(true);
  cleanup();
});

test("remove strips the block, tidies blanks, preserves the rest", () => {
  const { file, cleanup } = tmpFile();
  writeFileSync(file, `# Title\n\n${block("gone")}\n\nkeep\n`);
  expect(removeManagedBlock(file, B, E)).toBe("removed");
  const after = readFileSync(file, "utf8");
  expect(after).toContain("# Title");
  expect(after).toContain("keep");
  expect(after).not.toContain("gone");
  expect(removeManagedBlock(file, B, E)).toBe("absent");
  cleanup();
});

test("remove on an absent/empty file is a no-op", () => {
  const { file, cleanup } = tmpFile();
  expect(removeManagedBlock(file, B, E)).toBe("absent");
  expect(existsSync(file)).toBe(false);
  cleanup();
});
