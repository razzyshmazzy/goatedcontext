import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCodexWritableRoot, tomlRootValue } from "../src/adapters/codex/config.ts";

/**
 * Codex config.toml corruption regressions (security wave).
 *
 * The writer must NEVER produce invalid TOML or change the meaning of an existing
 * path. We prove it by re-parsing every successful result with an INDEPENDENT parser
 * (Bun's native `.toml` loader) and asserting the stored path values round-trip exactly.
 * A structure we cannot safely edit (an inline table) must be refused, not duplicated.
 */

const WIN = "win32" as NodeJS.Platform;
const NIX = "linux" as NodeJS.Platform;

let counter = 0;
function dir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-toml-corrupt-"));
}
/** Parse a TOML file with an independent parser; throws if the file is not valid TOML. */
async function parseToml(file: string): Promise<any> {
  const mod = await import(pathToFileURL(file).href + "?v=" + counter++);
  return mod.default;
}

test("single-quoted literal Windows path is preserved as valid TOML when a root is added", async () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    // A user-authored literal string with backslashes — the exact shape that the old
    // writer re-emitted as an invalid basic string ("D:\Users\x" → bad \U/\x escapes).
    writeFileSync(cfg, "[sandbox_workspace_write]\nwritable_roots = ['D:\\Users\\x']\n");
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\Admin\\.ctx", WIN);
    expect(r.action).toBe("added");

    const parsed = await parseToml(cfg); // throws if corrupt → test fails
    const roots: string[] = parsed.sandbox_workspace_write.writable_roots;
    expect(roots).toContain("D:\\Users\\x"); // original value EXACTLY preserved
    expect(roots).toContain("C:/Users/Admin/.ctx"); // our normalized root added
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("literal path with \\b / \\t sequences does not become control chars", async () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    // Literal (single-quoted) strings do NOT process escapes: these are backslash+letter.
    writeFileSync(cfg, "[sandbox_workspace_write]\nwritable_roots = ['C:\\builds\\tmp']\n");
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\Admin\\.ctx", WIN);
    expect(r.action).toBe("added");

    const parsed = await parseToml(cfg);
    const roots: string[] = parsed.sandbox_workspace_write.writable_roots;
    // The value must still be literal backslashes, NOT a backspace (0x08) or tab (0x09).
    expect(roots).toContain("C:\\builds\\tmp");
    expect(roots.some((p) => p.includes("\b") || p.includes("\t"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const WINDOWS_PATHS = [
  "C:\\Users\\x",
  "D:\\work\\repo",
  "C:\\Program Files\\Something",
  "C:\\Users\\name\\AppData\\Roaming",
];
for (const p of WINDOWS_PATHS) {
  test(`fresh config for Windows path "${p}" parses and value equals the intended path`, async () => {
    const home = dir();
    try {
      const cfg = join(home, "config.toml");
      const r = ensureCodexWritableRoot(cfg, p, WIN);
      expect(r.action).toBe("created");
      const parsed = await parseToml(cfg);
      const roots: string[] = parsed.sandbox_workspace_write.writable_roots;
      // The stored value is the forward-slash normalization of the Windows path, and it
      // must survive parsing byte-for-byte (no escape changed its meaning).
      expect(roots).toEqual([tomlRootValue(p, WIN)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("existing double-quoted basic string with escaped backslashes round-trips", async () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    writeFileSync(cfg, '[sandbox_workspace_write]\nwritable_roots = ["D:\\\\work\\\\repo"]\n');
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\Admin\\.ctx", WIN);
    expect(r.action).toBe("added");
    const parsed = await parseToml(cfg);
    expect(parsed.sandbox_workspace_write.writable_roots).toContain("D:\\work\\repo");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("path with spaces and unicode stays valid and round-trips", async () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\José Doe\\.ctx", WIN);
    expect(r.action).toBe("created");
    const parsed = await parseToml(cfg);
    expect(parsed.sandbox_workspace_write.writable_roots).toEqual(["C:/Users/José Doe/.ctx"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("POSIX path containing a backslash is preserved, not mangled", async () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    const r = ensureCodexWritableRoot(cfg, "/home/weird\\dir/.ctx", NIX);
    expect(r.action).toBe("created");
    const parsed = await parseToml(cfg);
    expect(parsed.sandbox_workspace_write.writable_roots).toEqual(["/home/weird\\dir/.ctx"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("inline-table sandbox_workspace_write: REFUSE (no duplicate table), file untouched", () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    const original = "sandbox_workspace_write = { network_access = false }\n";
    writeFileSync(cfg, original);
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\Admin\\.ctx", WIN);
    expect(r.action).toBe("error");
    expect(r.detail).toMatch(/inline table/i);
    expect(readFileSync(cfg, "utf8")).toBe(original); // never duplicated / corrupted
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("inline-table WITH an unrelated sibling table still refuses rather than corrupt", () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    const original =
      'model = "gpt-5"\nsandbox_workspace_write = { writable_roots = ["/srv/a"] }\n\n[mcp_servers.fs]\ncommand = "fs"\n';
    writeFileSync(cfg, original);
    const r = ensureCodexWritableRoot(cfg, "/home/test/.ctx", NIX);
    expect(r.action).toBe("error");
    expect(readFileSync(cfg, "utf8")).toBe(original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("multiline array with a literal Windows path appends and re-parses validly", async () => {
  const home = dir();
  try {
    const cfg = join(home, "config.toml");
    writeFileSync(
      cfg,
      "[sandbox_workspace_write]\nwritable_roots = [\n  'D:\\a\\b',\n  \"/srv/x\",\n]\n",
    );
    const r = ensureCodexWritableRoot(cfg, "C:\\Users\\Admin\\.ctx", WIN);
    expect(r.action).toBe("added");
    const parsed = await parseToml(cfg);
    const roots: string[] = parsed.sandbox_workspace_write.writable_roots;
    expect(roots).toContain("D:\\a\\b");
    expect(roots).toContain("/srv/x");
    expect(roots).toContain("C:/Users/Admin/.ctx");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
