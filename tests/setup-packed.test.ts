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
  return {
    ...BASE,
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
      const winVars = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE"];
      const missing = winVars.filter((k) => !envHas(k));
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
            `required win vars MISSING:            ${missing.join(", ") || "(none)"}`,
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
