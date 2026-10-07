import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
  ManagedBlockError,
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

// ── fail-closed regression matrix (security wave) ─────────────────────────────

// B. begin marker only → upsert/remove fail, original bytes unchanged.
test("begin marker without end: upsert FAILS CLOSED, bytes unchanged", () => {
  const { file, cleanup } = tmpFile();
  const original = `keep me\n\n${B}\nhalf written user text below\nmore\n`;
  writeFileSync(file, original);
  expect(() => upsertManagedBlock(file, B, E, block("fixed"))).toThrow(ManagedBlockError);
  expect(readFileSync(file, "utf8")).toBe(original); // untouched — no truncation
  expect(() => removeManagedBlock(file, B, E)).toThrow(ManagedBlockError);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(hasManagedBlock(file, B, E)).toBe(false); // not a well-formed block
  cleanup();
});

// D. begin marker appears in arbitrary user prose (no end) → must not truncate.
test("begin marker embedded in user prose does not truncate unrelated text", () => {
  const { file, cleanup } = tmpFile();
  const original = `Docs: write the marker like ${B} to open a block.\nSENTINEL-KEEP-ME\n`;
  writeFileSync(file, original);
  expect(() => upsertManagedBlock(file, B, E, block("x"))).toThrow(ManagedBlockError);
  expect(readFileSync(file, "utf8")).toBe(original);
  cleanup();
});

// C. end marker only → not a block; preserved as user text, no destructive removal.
test("stray end marker (no begin) is preserved as user text", () => {
  const { file, cleanup } = tmpFile();
  const original = `intro\n${E}\nSENTINEL\n`;
  writeFileSync(file, original);
  expect(removeManagedBlock(file, B, E)).toBe("absent"); // nothing to remove
  expect(readFileSync(file, "utf8")).toBe(original);
  // upsert appends a fresh block, preserving the stray end marker and user text.
  expect(upsertManagedBlock(file, B, E, block("new"))).toBe("updated");
  const after = readFileSync(file, "utf8");
  expect(after).toContain("SENTINEL");
  expect(after).toContain(`intro\n${E}`);
  expect(after).toContain("new");
  cleanup();
});

// F. nested / overlapping begins → fail closed.
test("nested begin markers fail closed, bytes unchanged", () => {
  const { file, cleanup } = tmpFile();
  const original = `${B}\nouter\n${B}\ninner\n${E}\n`;
  writeFileSync(file, original);
  expect(() => upsertManagedBlock(file, B, E, block("x"))).toThrow(ManagedBlockError);
  expect(readFileSync(file, "utf8")).toBe(original);
  cleanup();
});

// H + G. user text above AND below a valid block survives; CRLF style preserved.
test("CRLF file: user text above and below a valid block is preserved on refresh", () => {
  const { file, cleanup } = tmpFile();
  const original = `# Title\r\n\r\nabove\r\n\r\n${block("v1")}\r\n\r\nbelow-SENTINEL\r\n`;
  writeFileSync(file, original);
  expect(upsertManagedBlock(file, B, E, block("v2"))).toBe("updated");
  const after = readFileSync(file, "utf8");
  expect(after).toContain("above\r\n");
  expect(after).toContain("below-SENTINEL\r\n"); // trailing user content + CRLF intact
  expect(after).toContain("v2");
  expect(after).not.toContain("v1");
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
