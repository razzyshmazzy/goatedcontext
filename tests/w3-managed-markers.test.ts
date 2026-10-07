import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
  ManagedBlockError,
} from "../src/utils/managed-block.ts";

/**
 * CRLF / stray-marker edge cases (Wave 3 §24). Wave 1 made the parser fail-closed (no
 * truncation on malformed markers); this locks in the remaining newline/stray-marker
 * behavior without weakening that guarantee.
 */

const B = "<!-- gc:begin -->";
const E = "<!-- gc:end -->";
const block = (body: string) => `${B}\n${body}\n${E}`;

function tmpFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-mm-"));
  return { file: join(dir, "AGENTS.md"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("LF valid block: refresh preserves surrounding LF content", () => {
  const { file, cleanup } = tmpFile();
  writeFileSync(file, `# Title\n\nabove\n\n${block("v1")}\n\nbelow-SENTINEL\n`);
  expect(upsertManagedBlock(file, B, E, block("v2"))).toBe("updated");
  const after = readFileSync(file, "utf8");
  expect(after).toContain("above\n");
  expect(after).toContain("below-SENTINEL\n");
  expect(after).toContain("v2");
  expect(after).not.toContain("v1");
  cleanup();
});

test("CRLF valid block: user CRLF content preserved on refresh AND remove", () => {
  const { file, cleanup } = tmpFile();
  const original = `# Title\r\n\r\nabove-CRLF\r\n\r\n${block("v1")}\r\n\r\nbelow-CRLF\r\n`;
  writeFileSync(file, original);
  upsertManagedBlock(file, B, E, block("v2"));
  let after = readFileSync(file, "utf8");
  expect(after).toContain("above-CRLF\r\n");
  expect(after).toContain("below-CRLF\r\n");
  expect(after).toContain("v2");
  // Remove preserves the CRLF user content and never truncates it.
  expect(removeManagedBlock(file, B, E)).toBe("removed");
  after = readFileSync(file, "utf8");
  expect(after).toContain("above-CRLF");
  expect(after).toContain("below-CRLF");
  expect(after).not.toContain("v2");
  cleanup();
});

test("stray BEGIN marker (no end) fails closed, bytes unchanged (LF and CRLF)", () => {
  for (const nl of ["\n", "\r\n"]) {
    const { file, cleanup } = tmpFile();
    const original = `keep-me${nl}${B}${nl}USER-TEXT-BELOW${nl}`;
    writeFileSync(file, original);
    expect(() => upsertManagedBlock(file, B, E, block("x"))).toThrow(ManagedBlockError);
    expect(readFileSync(file, "utf8")).toBe(original); // no truncation
    cleanup();
  }
});

test("stray END marker (no begin) is preserved as user text", () => {
  const { file, cleanup } = tmpFile();
  const original = `intro\r\n${E}\r\nSENTINEL\r\n`;
  writeFileSync(file, original);
  expect(removeManagedBlock(file, B, E)).toBe("absent");
  expect(readFileSync(file, "utf8")).toBe(original);
  cleanup();
});

test("marker-like prose (begin text inside a sentence, no end) is not truncated", () => {
  const { file, cleanup } = tmpFile();
  const original = `Write the opening marker ${B} to start a block.\r\nKEEP-THIS\r\n`;
  writeFileSync(file, original);
  expect(() => upsertManagedBlock(file, B, E, block("x"))).toThrow(ManagedBlockError);
  expect(readFileSync(file, "utf8")).toBe(original);
  cleanup();
});

test("duplicated valid blocks dedupe to one; inter-block user text preserved", () => {
  const { file, cleanup } = tmpFile();
  writeFileSync(file, `${block("a")}\n\nMIDDLE\n\n${block("b")}\n`);
  upsertManagedBlock(file, B, E, block("c"));
  const after = readFileSync(file, "utf8");
  expect(after.match(/gc:begin/g)!.length).toBe(1);
  expect(after).toContain("MIDDLE");
  expect(after).toContain("c");
  cleanup();
});

test("no trailing newline vs trailing newline both handled on append", () => {
  const a = tmpFile();
  writeFileSync(a.file, "user content no newline");
  expect(upsertManagedBlock(a.file, B, E, block("x"))).toBe("updated");
  expect(readFileSync(a.file, "utf8")).toContain("user content no newline");
  expect(hasManagedBlock(a.file, B, E)).toBe(true);
  a.cleanup();

  const b = tmpFile();
  writeFileSync(b.file, "user content with newline\n");
  expect(upsertManagedBlock(b.file, B, E, block("x"))).toBe("updated");
  expect(readFileSync(b.file, "utf8")).toContain("user content with newline\n");
  b.cleanup();
});
