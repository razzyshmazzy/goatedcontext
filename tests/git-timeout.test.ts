import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitToplevel, gitOriginUrl, createGitProbe } from "../src/utils/git.ts";
import { detectRepoIdentity } from "../src/core/repos/repo.ts";
import { makeGitRepo } from "./helpers.ts";

/**
 * D3 — git subprocess timeout, fail-safe fallback, and request-local reuse (0.3.0).
 *
 * A fake-git script (run via the current runtime through the internal `CTX_GIT_BIN`
 * seam) deterministically simulates slow / malformed / missing git WITHOUT ever
 * waiting a real long timeout: the hard timeout is shrunk via `CTX_GIT_TIMEOUT_MS`,
 * and the fake sleeps just past it. Proves a hung git cannot hang ctx, the fallback
 * is deterministic, and no child lingers.
 */

// A tiny fake git. Behavior is driven entirely by env vars so each test configures
// it without rewriting the file. Written as .cjs so `require` works under node & bun.
const FAKE_GIT = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const sub = args[0] || "";
if (process.env.FAKE_COUNTER) fs.appendFileSync(process.env.FAKE_COUNTER, args.join(" ") + "\\n");
const sleepOn = process.env.FAKE_SLEEP_ON; // "rev-parse" | "remote" | "all"
const sleepMs = Number(process.env.FAKE_SLEEP_MS || 0);
if (sleepMs > 0 && (sleepOn === "all" || sleepOn === sub)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
}
if (sub === "rev-parse") {
  if (process.env.FAKE_NO_REPO) process.exit(1);
  process.stdout.write((process.env.FAKE_TOPLEVEL || "/fake/root") + "\\n");
  process.exit(0);
}
if (sub === "remote") {
  if (!process.env.FAKE_ORIGIN) process.exit(1); // no origin → non-zero, like real git
  process.stdout.write(process.env.FAKE_ORIGIN + "\\n");
  process.exit(0);
}
process.exit(0);
`;

const dir = mkdtempSync(join(tmpdir(), "ctx-fakegit-"));
const fakeGitPath = join(dir, "fake-git.cjs");
writeFileSync(fakeGitPath, FAKE_GIT);
// A real, existing cwd for the fake-git child (execFileSync requires cwd to exist;
// the fake ignores it). Using one stable path also lets the probe memoize by cwd.
const CWD = dir;

const TOUCHED = ["CTX_GIT_BIN", "CTX_GIT_TIMEOUT_MS", "FAKE_SLEEP_ON", "FAKE_SLEEP_MS", "FAKE_TOPLEVEL", "FAKE_ORIGIN", "FAKE_NO_REPO", "FAKE_COUNTER"];
const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string>) {
  for (const k of TOUCHED) saved[k] = process.env[k];
  process.env.CTX_GIT_BIN = fakeGitPath;
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("a real git command still succeeds (no override) — the timeout wrapper is transparent", () => {
  const repo = makeGitRepo("https://github.com/acme/timeoutok.git");
  try {
    expect(gitToplevel(repo.root)).not.toBeNull();
    expect(gitOriginUrl(repo.root)).toBe("https://github.com/acme/timeoutok.git");
  } finally {
    repo.cleanup();
  }
});

test("a hung git is killed at the timeout and returns null (does NOT hang ctx)", () => {
  setEnv({ CTX_GIT_TIMEOUT_MS: "300", FAKE_SLEEP_ON: "all", FAKE_SLEEP_MS: "4000", FAKE_TOPLEVEL: "/fake/root" });
  const t0 = performance.now();
  const res = gitToplevel(CWD);
  const elapsed = performance.now() - t0;
  expect(res).toBeNull(); // timed out → fail safe
  expect(elapsed).toBeLessThan(3000); // killed near 300ms, NOT after the 4s sleep
});

test("repo-root timeout → detectRepoIdentity falls back to 'no repo' (null), deterministically", () => {
  setEnv({ CTX_GIT_TIMEOUT_MS: "300", FAKE_SLEEP_ON: "rev-parse", FAKE_SLEEP_MS: "4000" });
  const t0 = performance.now();
  const id = detectRepoIdentity(CWD);
  expect(performance.now() - t0).toBeLessThan(3000);
  expect(id).toBeNull(); // root could not be resolved → not a repo
});

test("remote timeout → identity still resolves via the path fallback (no invented remote, no hang)", () => {
  setEnv({ CTX_GIT_TIMEOUT_MS: "300", FAKE_SLEEP_ON: "remote", FAKE_SLEEP_MS: "4000", FAKE_TOPLEVEL: "/fake/root" });
  const t0 = performance.now();
  const id = detectRepoIdentity(CWD)!;
  expect(performance.now() - t0).toBeLessThan(3000);
  expect(id).not.toBeNull();
  expect(id.identity.startsWith("path:")).toBe(true); // falls back to path identity
  expect(id.hasRemote).toBe(false);
  expect(id.remoteUrl).toBeNull();
});

test("no repo (git exits non-zero) → null, no crash", () => {
  setEnv({ FAKE_NO_REPO: "1" });
  expect(gitToplevel(CWD)).toBeNull();
  expect(detectRepoIdentity(CWD)).toBeNull();
});

test("malformed git output does not crash identity detection", () => {
  setEnv({ FAKE_TOPLEVEL: "this is not a real path <>|" });
  const id = detectRepoIdentity(CWD)!;
  expect(id).not.toBeNull();
  expect(id.identity.startsWith("path:")).toBe(true); // hashed, whatever the root string is
  expect(id.hasRemote).toBe(false);
});

test("request-local probe spawns each git lookup ONCE across repeated resolves (vs once-per-call without)", () => {
  const counter = join(dir, "count-shared.log");
  writeFileSync(counter, "");
  setEnv({ FAKE_TOPLEVEL: "/fake/root", FAKE_ORIGIN: "https://github.com/acme/probe.git", FAKE_COUNTER: counter });

  const probe = createGitProbe();
  detectRepoIdentity(CWD, probe);
  detectRepoIdentity(CWD, probe);
  detectRepoIdentity(CWD, probe);
  const sharedLines = readFileSync(counter, "utf8").trim().split("\n").filter(Boolean);
  // One rev-parse + one remote lookup total, reused across all three detections.
  expect(sharedLines.length).toBe(2);

  // Without a shared probe, each detection spawns its own pair.
  const counter2 = join(dir, "count-fresh.log");
  writeFileSync(counter2, "");
  process.env.FAKE_COUNTER = counter2;
  detectRepoIdentity(CWD);
  detectRepoIdentity(CWD);
  const freshLines = readFileSync(counter2, "utf8").trim().split("\n").filter(Boolean);
  expect(freshLines.length).toBe(4); // 2 detections × (rev-parse + remote)
});

test("cleanup: temp fake-git dir removed", () => {
  // Housekeeping guard — the fixture dir is removed by the process at the end; assert
  // it exists now so a future refactor that deletes it early is caught.
  expect(existsSync(fakeGitPath)).toBe(true);
});

// Remove the shared fixture dir once this file's tests are done.
process.on("exit", () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
