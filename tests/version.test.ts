import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";
import { whichSync } from "../src/utils/runtime.ts";

// package.json is the single source of truth for the version. These tests assert
// that both the source module and the BUILT artifact agree with it — so a stale,
// hand-duplicated constant can never ship again.

const ROOT = join(import.meta.dir, "..");
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

test("source VERSION module matches package.json", () => {
  expect(VERSION).toBe(PKG_VERSION);
});

test("no hand-duplicated version constant remains in the CLI source", () => {
  const cli = readFileSync(join(ROOT, "src", "cli", "index.ts"), "utf8");
  // The old `const VERSION = "x.y.z"` literal must be gone; version comes from the module.
  expect(cli).not.toMatch(/const\s+VERSION\s*=\s*["']\d/);
});

test("running the CLI from source reports the package version", () => {
  const res = spawnSync(process.execPath, ["run", join(ROOT, "src", "index.ts"), "--version"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  expect(res.stdout.trim()).toBe(PKG_VERSION);
});

test("the built bundle carries the injected version (no runtime package.json lookup)", () => {
  const dist = join(ROOT, "dist", "index.js");
  const node = whichSync("node");
  if (!node || !existsSync(dist)) {
    console.warn("[version] skipped built-artifact check: run `bun run build` first.");
    return;
  }
  const res = spawnSync(node, [dist, "--version"], { encoding: "utf8" });
  expect(res.stdout.trim()).toBe(PKG_VERSION);
  // The version is embedded as a literal in the bundle.
  expect(readFileSync(dist, "utf8")).toContain(PKG_VERSION);
});
