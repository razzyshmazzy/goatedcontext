import { test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { runSetup } from "../src/cli/setup.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";
import { captureChild, persistentPath, whichSync } from "../src/utils/runtime.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Real, public-path upgrade tests: they drive the ACTUAL `runSetup` with the real
// npm install + real fresh-process verification, isolated to a throwaway npm
// global prefix (never the machine's real global). The decisive assertions are that
// after setup the PERSISTENT `ctx` reports exactly the running package version AND the
// global package is a REAL directory — never a symlink/junction into the npx cache.
//
// Installs go through an actual `.tgz` (via `npm pack`), NOT a source directory:
// installing a directory is exactly what made npm LINK the global package back into
// the ephemeral `_npx` cache (the deeper 0.2.3 breakage this release fixes).

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist", "index.js");
const isWin = process.platform === "win32";
const LAUNCHER = isWin ? "ctx.cmd" : "ctx";
const NPM = whichSync("npm");
const NODE = whichSync("node");
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const TIMEOUT = 180_000;

const ready = Boolean(NPM && NODE && existsSync(DIST));

/** A minimal older `goatedcontext` whose `ctx` just prints an old version. */
function fakeOld(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-old-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "goatedcontext", version, bin: { ctx: "ctx.js", goatedcontext: "ctx.js" } }),
  );
  writeFileSync(join(dir, "ctx.js"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`);
  return dir;
}

function binDirFor(prefix: string): string {
  return isWin ? prefix : join(prefix, "bin");
}

/** Where npm installs the global PACKAGE (not its bin) under a given prefix. */
function globalPackageDirFor(prefix: string): string {
  return isWin
    ? join(prefix, "node_modules", "goatedcontext")
    : join(prefix, "lib", "node_modules", "goatedcontext");
}

/** A real npx-style `ctx` shim that just prints a fixed version (like npm's shims). */
function writeEphemeralCtx(binDir: string, version: string): void {
  if (isWin) {
    writeFileSync(join(binDir, "ctx.cmd"), `@echo off\r\necho ${version}\r\n`);
  } else {
    const p = join(binDir, "ctx");
    writeFileSync(p, `#!/bin/sh\necho ${version}\n`);
    chmodSync(p, 0o755);
  }
}

/**
 * `npm pack` a package DIRECTORY into a `.tgz` and return its absolute path (plus the
 * temp dir to clean up). `--ignore-scripts` avoids re-running the repo's prepack build.
 * Installing this tarball exercises the SAME package-copy semantics as a registry
 * install — and, unlike a directory install, cannot produce a link back into a cache.
 */
function packTarball(pkgDir: string, env: NodeJS.ProcessEnv): { tarball: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-tgz-"));
  const res = captureChild("npm", ["pack", pkgDir, "--pack-destination", dir, "--ignore-scripts"], {
    env,
  });
  if (res.code !== 0) {
    console.error(`npm pack failed (code ${res.code}):\n${res.stderr || res.stdout}`);
    throw new Error("npm pack failed");
  }
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack produced no .tgz in ${dir}`);
  return { tarball: join(dir, tgz), dir };
}

/**
 * A real goatedcontext-shaped package living inside an npx-style cache path
 * (`.../_npx/<hash>/node_modules/goatedcontext`). Used to reproduce the broken linked
 * install: a global package symlinked/junctioned into this ephemeral directory.
 */
function makeNpxCachePackage(version: string): { pkgDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ctx-npxcache-"));
  const pkgDir = join(root, "_npx", "deadbeef", "node_modules", "goatedcontext");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "goatedcontext",
      version,
      bin: { ctx: "dist/index.js", goatedcontext: "dist/index.js" },
    }),
  );
  writeFileSync(
    join(pkgDir, "dist", "index.js"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
  );
  return { pkgDir, root };
}

/**
 * A base env with ALL `npm_*` variables removed. This matters because the suite
 * may itself run inside an npm lifecycle (e.g. `npm publish`'s `prepublishOnly`),
 * which injects `npm_config_prefix`/`npm_config_*` that would otherwise redirect
 * where these tests' npm installs and prefix queries resolve.
 */
function npmSanitizedBase(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_/i.test(k)) continue;
    base[k] = v;
  }
  return base;
}
const BASE = npmSanitizedBase();

/**
 * The minimum system env vars `cmd.exe` / `npm.cmd` need to run on Windows. The
 * isolated env is passed to the child WHOLESALE (it replaces, not merges with, the
 * parent env — see `spawnPortable`), and Windows runs `.cmd` shims through
 * `cmd.exe` (`shell: true`). Without these, that `cmd.exe` cannot initialize or
 * resolve `npm.cmd` (needs `PATHEXT`), so `npm install -g` exits 1 before any
 * product logic runs — the Windows-only CI failure. POSIX needs none of these.
 */
const WIN_SYSTEM_VARS = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
] as const;

/**
 * Copy the required Windows system vars from the REAL environment (case-insensitively,
 * since Windows env keys vary in case), preserving their canonical names. Real values
 * are copied when present; the only synthesized default is `PATHEXT` (so `.cmd`
 * resolution always works). Never inserts an empty-string var. Returns `{}` off Windows.
 */
function windowsSystemEnv(): NodeJS.ProcessEnv {
  if (!isWin) return {};
  const out: NodeJS.ProcessEnv = {};
  for (const name of WIN_SYSTEM_VARS) {
    const hit = Object.entries(process.env).find(([k]) => k.toLowerCase() === name.toLowerCase());
    const value = hit?.[1];
    if (value) out[name] = value;
    else if (name === "PATHEXT") out[name] = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";
    // Otherwise leave it unset rather than inject an empty string.
  }
  return out;
}

// The machine's REAL npm global bin dir (computed with a sanitized env), stripped
// from the test PATH so the isolated prefix is truly isolated — otherwise a real
// `ctx` on the tester's PATH would masquerade as an existing install.
const REAL_GLOBAL = ready ? captureChild("npm", ["prefix", "-g"], { env: BASE }).stdout.trim() : "";
const REAL_GLOBAL_BINS = REAL_GLOBAL
  ? [REAL_GLOBAL, join(REAL_GLOBAL, "bin")].map((p) => p.replace(/[\\/]+$/, "").toLowerCase())
  : [];

function cleanPath(): string {
  return (BASE.PATH ?? "")
    .split(delimiter)
    .filter((p) => p && !REAL_GLOBAL_BINS.includes(p.replace(/[\\/]+$/, "").toLowerCase()))
    .join(delimiter);
}

// The directories holding `node` and `npm` themselves. These MUST stay on the
// isolated PATH: if `cleanPath()` (which strips the real global bin dir) happens
// to remove the directory that also holds the npm shim — as it does on Node
// version-manager layouts where `npm prefix -g` and the npm shim share a dir —
// then `which("npm")` fails and the install spawns a bare "npm" with no shell,
// dying with ENOENT (exit 1, empty stderr). Prepending them makes the harness
// robust to that layout without touching production code or the assertions.
const TOOL_DIRS = [NPM, NODE].filter(Boolean).map((p) => dirname(p as string));

function isoEnv(prefix: string, home: string): NodeJS.ProcessEnv {
  const binDir = binDirFor(prefix);
  const path = [binDir, ...TOOL_DIRS, cleanPath()].filter(Boolean).join(delimiter);
  // On Windows the isolated env is built from an EXPLICIT allow-list so the handful
  // of system vars cmd.exe/npm.cmd require are always present under their canonical
  // names (the blanket `...BASE` spread was observed to drop them on CI, breaking
  // `npm install -g` before product logic ran). `HOME` points at the isolated test
  // home too, so npm's config/cache never escape the sandbox. POSIX is unchanged:
  // it needs none of these and the full BASE already carries PATH + HOME.
  const systemBase: NodeJS.ProcessEnv = isWin ? { ...windowsSystemEnv(), HOME: home } : { ...BASE };
  return {
    ...systemBase,
    npm_config_prefix: prefix, // both `npm prefix -g` and `npm install -g` target here
    CTX_HOME: home,
    CTX_SECRET_BACKEND: "file",
    PATH: path,
  };
}

const REMOVED_NPM_KEYS = Object.keys(process.env).filter((k) => /^npm_/i.test(k));

/**
 * Install a package DIR globally into the isolated prefix (real npm). On an
 * unexpected nonzero exit it prints the FULL context (command, args, cwd, prefix,
 * PATH, npm_config_prefix, exit, stdout, stderr, resolved npm) instead of
 * swallowing the failure behind a bare exit code.
 */
function npmInstallGlobal(pkgDir: string, env: NodeJS.ProcessEnv): number {
  // captureChild handles Windows `.cmd` + spaces-in-path quoting correctly.
  const res = captureChild("npm", ["install", "-g", pkgDir], { env });
  if (res.code !== 0) {
    const resolvedNpm = whichSync("npm", env.PATH);
    console.error(
      [
        "",
        "=== npm install -g FAILED ===",
        `command:            npm install -g ${pkgDir}`,
        `resolved npm:       ${resolvedNpm ?? "(whichSync could NOT resolve npm on the isolated PATH)"}`,
        `cwd:                ${process.cwd()}`,
        `npm_config_prefix:  ${env.npm_config_prefix ?? "(unset)"}`,
        `removed npm_* keys: ${REMOVED_NPM_KEYS.join(", ") || "(none)"}`,
        `PATH:               ${env.PATH}`,
        `exit code:          ${res.code}`,
        `stdout:\n${res.stdout || "(empty)"}`,
        `stderr:\n${res.stderr || "(empty)"}`,
        "=== end npm failure ===",
        "",
      ].join("\n"),
    );
  }
  return res.code;
}

/** Run the installed launcher's `--version` in a fresh process. */
function installedVersion(prefix: string): string | null {
  const launcher = join(binDirFor(prefix), LAUNCHER);
  if (!existsSync(launcher)) return null;
  const res = captureChild(launcher, ["--version"], {});
  const m = res.stdout.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

function scratch(): { prefix: string; home: string; claudeHome: string; cleanup: () => void } {
  const prefix = mkdtempSync(join(tmpdir(), "ctx-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "ctx-home-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "ctx-claude-"));
  return {
    prefix,
    home,
    claudeHome,
    cleanup: () => {
      for (const d of [prefix, home, claudeHome]) rmSync(d, { recursive: true, force: true });
    },
  };
}

test("Windows: the isolated env preserves every system var cmd.exe/npm.cmd need", () => {
  if (!isWin) return; // Windows-only guard: these vars don't exist on POSIX.
  const s = scratch();
  try {
    const env = isoEnv(s.prefix, s.home);
    // Case-insensitive presence check (Windows env keys vary in case).
    const value = (name: string) =>
      Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    const missing = WIN_SYSTEM_VARS.filter((name) => !value(name));
    expect(missing).toEqual([]); // every required cmd.exe/npm.cmd var is present and non-empty
    // Isolation is still intact: HOME points at the test home, the npm prefix/CTX_HOME
    // are the isolated ones, and no npm_* lifecycle var leaked back in.
    expect(value("HOME")).toBe(s.home);
    expect(env.npm_config_prefix).toBe(s.prefix);
    expect(env.CTX_HOME).toBe(s.home);
    expect(Object.keys(env).some((k) => /^npm_(?!config_prefix$)/i.test(k))).toBe(false);
  } finally {
    s.cleanup();
  }
});

test(
  "diagnostic: the isolated npm environment can actually run npm",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    try {
      const env = isoEnv(s.prefix, s.home);
      const resolvedNpm = whichSync("npm", env.PATH);
      // Windows env var names are case-insensitive; the plain-object env may store
      // them in any casing (e.g. COMSPEC vs ComSpec), so look them up case-insensitively.
      const envHas = (name: string) =>
        Object.keys(env).some((k) => k.toLowerCase() === name.toLowerCase() && env[k]);
      // The process vars that MUST survive env sanitization for `npm` to run are
      // platform-specific. On Windows, cmd/npm need the core system vars; on POSIX
      // those don't exist at all, and the only vars this test genuinely depends on
      // are PATH (to resolve/run npm) and HOME (npm's cache/config). Asserting the
      // Windows set on Ubuntu/macOS was the cross-platform CI regression.
      const requiredVars = isWin ? [...WIN_SYSTEM_VARS] : ["PATH", "HOME"];
      const missing = requiredVars.filter((k) => !envHas(k));
      const npmVersion = captureChild("npm", ["--version"], { env });
      // Only shout when something is actually wrong, so normal runs stay quiet but
      // a broken isolated env prints exactly why npm can't run.
      if (!resolvedNpm || npmVersion.code !== 0 || missing.length > 0) {
        console.warn(
          [
            "",
            "=== isolated npm environment (PROBLEM DETECTED) ===",
            `removed npm_* keys: ${REMOVED_NPM_KEYS.join(", ") || "(none)"}`,
            `our npm_config_prefix (must survive): ${env.npm_config_prefix}`,
            `REAL_GLOBAL (stripped from PATH):     ${REAL_GLOBAL}`,
            `tool dirs prepended:                  ${TOOL_DIRS.join(", ")}`,
            `resolved npm on isolated PATH:        ${resolvedNpm ?? "(NOT RESOLVED — this breaks the install)"}`,
            `npm --version:                        code=${npmVersion.code} out=${npmVersion.stdout.trim() || "(empty)"} err=${npmVersion.stderr.trim() || "(empty)"}`,
            `required ${isWin ? "win" : "posix"} vars MISSING:          ${missing.join(", ") || "(none)"}`,
            `PATH:                                 ${env.PATH}`,
            "=== end ===",
            "",
          ].join("\n"),
        );
      }
      // Hard regression guard: npm MUST be resolvable and runnable inside the
      // isolated env, and the critical Windows process vars must survive.
      expect(resolvedNpm).not.toBeNull();
      expect(npmVersion.code).toBe(0);
      expect(missing).toEqual([]);
    } finally {
      s.cleanup();
    }
  },
  TIMEOUT,
);

test(
  "A. no global installation → fresh .tgz install is a REAL package at the running version",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const env = isoEnv(s.prefix, s.home);
    const main = packTarball(ROOT, env);
    try {
      const result = runSetup({
        env,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: main.tarball,
      });
      expect(result.globalInstall).toBe("installed");
      expect(result.previousVersion).toBeNull();
      expect(result.previousInstallLinked).toBe(false);
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      // Independent proof: the persistent launcher reports the running version...
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);
      // ...and the global package is a REAL directory, not a link into any cache.
      const gpkg = globalPackageDirFor(s.prefix);
      expect(lstatSync(gpkg).isSymbolicLink()).toBe(false);
      expect(realpathSync(gpkg).toLowerCase()).not.toContain("_npx");
    } finally {
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "B. older normal global install → setup UPGRADES the persistent CLI to the running version",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const env = isoEnv(s.prefix, s.home);
    const main = packTarball(ROOT, env);
    const oldPkg = fakeOld("0.2.3");
    const oldTgz = packTarball(oldPkg, env);
    try {
      // Seed an OLD, NORMAL persistent install (from a real tarball).
      expect(npmInstallGlobal(oldTgz.tarball, env)).toBe(0);
      expect(installedVersion(s.prefix)).toBe("0.2.3");

      const result = runSetup({
        env,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: main.tarball,
      });
      expect(result.globalInstall).toBe("upgraded");
      expect(result.previousVersion).toBe("0.2.3");
      expect(result.previousInstallLinked).toBe(false);
      expect(result.installedVersion).toBe(PKG_VERSION);
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);
    } finally {
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
      rmSync(oldTgz.dir, { recursive: true, force: true });
      rmSync(oldPkg, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "C. same-version normal install → present, idempotent (no reinstall), integration re-wires",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const env = isoEnv(s.prefix, s.home);
    const main = packTarball(ROOT, env);
    try {
      expect(npmInstallGlobal(main.tarball, env)).toBe(0);
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);

      const result = runSetup({
        env,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: main.tarball,
      });
      expect(result.globalInstall).toBe("present"); // real package, current → not reinstalled
      expect(result.previousInstallLinked).toBe(false);
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);

      // Second run is safe and idempotent (matrix item J: integration refresh).
      const again = runSetup({
        env,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: main.tarball,
      });
      expect(again.globalInstall).toBe("present");
      expect(again.ok).toBe(true);
    } finally {
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "H. failed registry/tarball install → nonzero, no false success, npm stderr surfaced",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    try {
      const env = isoEnv(s.prefix, s.home);
      // A nonexistent local tarball → npm install fails WITHOUT touching the network,
      // and we must NOT fall back to linking anything.
      const missingTgz = join(tmpdir(), "goatedcontext-0.0.0-does-not-exist.tgz");
      const result = runSetup({
        env,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: missingTgz,
      });
      expect(result.globalInstall).toBe("failed");
      expect(result.ok).toBe(false);
      expect(result.warnings.join("\n").toLowerCase()).toContain("npm");
      expect(installedVersion(s.prefix)).toBeNull(); // nothing persisted
    } finally {
      s.cleanup();
    }
  },
  TIMEOUT,
);

test(
  "npx-mutated PATH over a normal old install → UPGRADES (ignores the ephemeral shim)",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const env = isoEnv(s.prefix, s.home);
    const main = packTarball(ROOT, env);
    const oldPkg = fakeOld("0.2.3");
    const oldTgz = packTarball(oldPkg, env);
    // A real npx-style ephemeral bin: `.../_npx/<hash>/node_modules/.bin/ctx` printing
    // the RUNNING version — exactly what `npx goatedcontext setup` puts on PATH.
    const npxRoot = mkdtempSync(join(tmpdir(), "ctx-npxbin-"));
    const ephemeralBin = join(npxRoot, "_npx", "cafebabe", "node_modules", ".bin");
    mkdirSync(ephemeralBin, { recursive: true });
    writeEphemeralCtx(ephemeralBin, PKG_VERSION);
    try {
      expect(npmInstallGlobal(oldTgz.tarball, env)).toBe(0);
      expect(installedVersion(s.prefix)).toBe("0.2.3");

      const npxEnv = { ...env, PATH: [ephemeralBin, env.PATH].join(delimiter) };
      // Trap sanity: raw PATH resolves the ephemeral shim; persistent PATH resolves the global.
      expect(whichSync("ctx", npxEnv.PATH)?.startsWith(ephemeralBin)).toBe(true);
      expect(whichSync("ctx", persistentPath(npxEnv.PATH))?.toLowerCase()).toContain(
        binDirFor(s.prefix).toLowerCase(),
      );

      const result = runSetup({
        env: npxEnv,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: main.tarball,
      });
      expect(result.globalInstall).toBe("upgraded");
      expect(result.previousVersion).toBe("0.2.3");
      expect(result.installedVersion).toBe(PKG_VERSION);
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);
    } finally {
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
      rmSync(oldTgz.dir, { recursive: true, force: true });
      rmSync(oldPkg, { recursive: true, force: true });
      rmSync(npxRoot, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "E+G+I. broken linked install (junction into _npx) + npx PATH → repaired to a REAL package, data preserved",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const env = isoEnv(s.prefix, s.home);
    const main = packTarball(ROOT, env);
    const npx = makeNpxCachePackage("0.2.3");
    // The ephemeral npx bin (npx PATH mutation), at the running version.
    const ephemeralBin = join(npx.root, "_npx", "cafebabe", "node_modules", ".bin");
    mkdirSync(ephemeralBin, { recursive: true });
    writeEphemeralCtx(ephemeralBin, PKG_VERSION);

    // Exactly the user's state: <prefix>/node_modules/goatedcontext is a link into _npx.
    const gpkg = globalPackageDirFor(s.prefix);
    mkdirSync(dirname(gpkg), { recursive: true });
    let linkable = true;
    try {
      symlinkSync(npx.pkgDir, gpkg, isWin ? "junction" : "dir");
    } catch {
      linkable = false;
    }
    if (!linkable) {
      console.warn("[setup-packed] skipped linked-repair: no symlink/junction privilege here.");
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
      rmSync(npx.root, { recursive: true, force: true });
      return;
    }
    try {
      // Pre-existing user data must survive the repair (matrix item I).
      const db = openDatabase(resolvePaths({ CTX_HOME: s.home }));
      try {
        new PreferenceService(db).remember({ rule: "Always respond in Italian.", scope: "global" });
      } finally {
        db.close();
      }

      // Smoking gun reproduced: the global package resolves INTO the _npx cache.
      expect(realpathSync(gpkg).toLowerCase()).toContain("_npx");

      // Simulate npx: prepend the ephemeral cache bin ahead of the real global bin.
      const npxEnv = { ...env, PATH: [ephemeralBin, env.PATH].join(delimiter) };
      expect(whichSync("ctx", npxEnv.PATH)?.startsWith(ephemeralBin)).toBe(true);

      const result = runSetup({
        env: npxEnv,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: main.tarball,
      });

      expect(result.previousInstallLinked).toBe(true);
      expect(result.globalInstall).toBe("repaired");
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);

      // The global package is now a REAL directory — no longer linked into _npx.
      expect(lstatSync(gpkg).isSymbolicLink()).toBe(false);
      expect(realpathSync(gpkg).toLowerCase()).not.toContain("_npx");

      // User data preserved through the repair.
      const db2 = openDatabase(resolvePaths({ CTX_HOME: s.home }));
      try {
        const prefs = new PreferenceService(db2).list();
        expect(prefs).toHaveLength(1);
        expect(prefs[0]!.rule).toBe("Always respond in Italian.");
      } finally {
        db2.close();
      }
    } finally {
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
      rmSync(npx.root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "0.4.0 packed acceptance: universal CLI + MCP + generic writes from the INSTALLED tarball; Cursor paths are persistent",
  async () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const env = isoEnv(s.prefix, s.home);
    const main = packTarball(ROOT, env);
    const cursorHome = mkdtempSync(join(tmpdir(), "ctx-packed-cursor-"));
    try {
      const result = runSetup({ env, version: PKG_VERSION, claudeHome: s.claudeHome, installSpec: main.tarball });
      expect(result.ok).toBe(true);
      const launcher = join(binDirFor(s.prefix), LAUNCHER);
      const dist = join(globalPackageDirFor(s.prefix), "dist", "index.js");
      expect(existsSync(dist)).toBe(true); // the self-contained bundle shipped in the tarball

      // doctor: no failing checks from the installed package.
      const doc = JSON.parse(captureChild(launcher, ["doctor", "--json"], { env }).stdout);
      expect(doc.ok).toBe(true);
      // The universal-interface checks are present. (mcp-launchable's ok/warn depends on
      // PATH resolution, which the isolated test prefix doesn't always replicate; the REAL
      // launchability proof is the SDK client connecting to the packed bundle below.)
      expect(doc.checks.find((c: { id: string }) => c.id === "mcp-launchable")).toBeTruthy();
      expect(doc.checks.find((c: { id: string }) => c.id === "agent-cli")?.status).toBe("ok");

      // Universal CLI: the stable JSON envelope.
      const before = JSON.parse(captureChild(launcher, ["agent", "context", "--task", "x", "--json"], { env }).stdout);
      expect(before.version).toBe(1);

      // Generic writes through the installed binary, then re-read.
      expect(captureChild(launcher, ["agent", "remember", "Prefer tabs.", "--origin", "user", "--always"], { env }).code).toBe(0);
      expect(
        captureChild(launcher, ["agent", "signal", "add", "--origin", "user", "--domain", "database", "--choice", "postgres", "--no-repo"], { env }).code,
      ).toBe(0);
      const after = JSON.parse(captureChild(launcher, ["agent", "context", "--task", "x", "--json"], { env }).stdout);
      expect(after.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).toContain("Prefer tabs.");

      // MCP from the INSTALLED bundle, under plain Node (exactly how the launcher runs it).
      const transport = new StdioClientTransport({
        command: NODE as string,
        args: [dist, "mcp"],
        env: { ...(env as Record<string, string>) },
      });
      const client = new Client({ name: "packed-test", version: "1.0.0" });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          "explain_preference", "get_context", "list_preferences", "propose", "record_decision", "remember",
        ]);
        const res = await client.callTool({ name: "get_context", arguments: { task: "x" } });
        const text = ((res.content ?? []) as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
        const envelope = JSON.parse(text);
        expect(envelope.version).toBe(1);
        // The write made via the CLI above is visible to the packed MCP server (shared SQLite).
        expect(envelope.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).toContain("Prefer tabs.");
      } finally {
        await client.close();
      }

      // Cursor install from the installed binary: mcp.json points at the PERSISTENT launcher,
      // never the source checkout, node_modules, or an npx cache. `--cwd` is a non-repo temp
      // dir so the sync step no-ops (never writes AGENTS.md into the test's working directory).
      expect(captureChild(launcher, ["install", "cursor", "--cursor-home", cursorHome, "--cwd", s.home], { env }).code).toBe(0);
      const mcpRaw = readFileSync(join(cursorHome, "mcp.json"), "utf8");
      expect(mcpRaw).not.toContain(ROOT);
      expect(mcpRaw.toLowerCase()).not.toContain("_npx");
      expect(mcpRaw).not.toContain("node_modules");
      const mcpParsed = JSON.parse(mcpRaw);
      expect(mcpParsed.mcpServers.goatedcontext.args).toEqual(["mcp"]);
    } finally {
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
      rmSync(cursorHome, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "F. an existing user database survives a normal upgrade (data preserved + migrated)",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const env = isoEnv(s.prefix, s.home);
    const main = packTarball(ROOT, env);
    const oldPkg = fakeOld("0.2.3");
    const oldTgz = packTarball(oldPkg, env);
    try {
      // Pre-existing user data in CTX_HOME.
      const db = openDatabase(resolvePaths({ CTX_HOME: s.home }));
      try {
        new PreferenceService(db).remember({
          rule: "Always respond in Italian.",
          scope: "global",
        });
      } finally {
        db.close();
      }

      npmInstallGlobal(oldTgz.tarball, env);
      const result = runSetup({
        env,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        installSpec: main.tarball,
      });
      expect(result.ok).toBe(true);
      expect(result.globalInstall).toBe("upgraded");

      // The preference (and its applicability) is still present after upgrade.
      const db2 = openDatabase(resolvePaths({ CTX_HOME: s.home }));
      try {
        const prefs = new PreferenceService(db2).list();
        expect(prefs).toHaveLength(1);
        expect(prefs[0]!.rule).toBe("Always respond in Italian.");
        expect(prefs[0]!.applicability).toBe("always");
      } finally {
        db2.close();
      }
    } finally {
      s.cleanup();
      rmSync(main.dir, { recursive: true, force: true });
      rmSync(oldTgz.dir, { recursive: true, force: true });
      rmSync(oldPkg, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
