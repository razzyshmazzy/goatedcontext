import { test, expect } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
// global prefix (never the machine's real global). The decisive assertion is that
// after setup the PERSISTENT `ctx` reports exactly the running package version.

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist", "index.js");
const isWin = process.platform === "win32";
const LAUNCHER = isWin ? "ctx.cmd" : "ctx";
const NPM = whichSync("npm");
const NODE = whichSync("node");
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const TIMEOUT = 180_000;

const ready = Boolean(NPM && NODE && existsSync(DIST));

/** A "published" package dir (package.json + built dist + docs), like the npx cache. */
function publishedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-pub-"));
  cpSync(join(ROOT, "dist"), join(dir, "dist"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  cpSync(join(ROOT, "README.md"), join(dir, "README.md"));
  cpSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  return dir;
}

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
  "A. no global installation → fresh install reports the running version",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const pub = publishedDir();
    try {
      const env = isoEnv(s.prefix, s.home);
      const result = runSetup({ env, version: PKG_VERSION, claudeHome: s.claudeHome, packageRoot: pub });
      expect(result.globalInstall).toBe("installed");
      expect(result.previousVersion).toBeNull();
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      // Independent proof: the persistent launcher reports the running version.
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);
    } finally {
      s.cleanup();
      rmSync(pub, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "D. older global installation → setup UPGRADES the persistent CLI to the running version",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const pub = publishedDir();
    const old = fakeOld("0.2.3");
    try {
      const env = isoEnv(s.prefix, s.home);
      // Seed an OLD persistent install (the reported starting state).
      expect(npmInstallGlobal(old, env)).toBe(0);
      expect(installedVersion(s.prefix)).toBe("0.2.3");

      const result = runSetup({ env, version: PKG_VERSION, claudeHome: s.claudeHome, packageRoot: pub });
      expect(result.globalInstall).toBe("upgraded");
      expect(result.previousVersion).toBe("0.2.3");
      expect(result.installedVersion).toBe(PKG_VERSION);
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      // The persistent version ACTUALLY changed on disk.
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);
    } finally {
      s.cleanup();
      rmSync(pub, { recursive: true, force: true });
      rmSync(old, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "C. same-version installation → present, idempotent (no reinstall), stays correct",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const pub = publishedDir();
    try {
      const env = isoEnv(s.prefix, s.home);
      expect(npmInstallGlobal(pub, env)).toBe(0);
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);

      const result = runSetup({ env, version: PKG_VERSION, claudeHome: s.claudeHome, packageRoot: pub });
      expect(result.globalInstall).toBe("present"); // already current → not reinstalled
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);

      // Second run is safe and reports current again.
      const again = runSetup({ env, version: PKG_VERSION, claudeHome: s.claudeHome, packageRoot: pub });
      expect(again.globalInstall).toBe("present");
      expect(again.ok).toBe(true);
    } finally {
      s.cleanup();
      rmSync(pub, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "E. failed global installation → nonzero, no false success, npm stderr surfaced",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    try {
      const env = isoEnv(s.prefix, s.home);
      // packageRoot points at a directory with no package.json → npm install fails.
      const bogus = mkdtempSync(join(tmpdir(), "ctx-bogus-"));
      try {
        const result = runSetup({ env, version: PKG_VERSION, claudeHome: s.claudeHome, packageRoot: bogus });
        expect(result.globalInstall).toBe("failed");
        expect(result.ok).toBe(false);
        expect(result.warnings.join("\n").toLowerCase()).toContain("npm");
        expect(installedVersion(s.prefix)).toBeNull(); // nothing persisted
      } finally {
        rmSync(bogus, { recursive: true, force: true });
      }
    } finally {
      s.cleanup();
    }
  },
  TIMEOUT,
);

test(
  "G. npx-mutated PATH (ephemeral `ctx` at running version) → still UPGRADES the persistent CLI",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const pub = publishedDir();
    const old = fakeOld("0.2.3");
    // A real npx-style ephemeral bin: `.../_npx/<hash>/node_modules/.bin/ctx` printing
    // the RUNNING version — exactly what `npx goatedcontext setup` puts on PATH.
    const npxRoot = mkdtempSync(join(tmpdir(), "ctx-npxcache-"));
    const ephemeralBin = join(npxRoot, "_npx", "cafebabe", "node_modules", ".bin");
    mkdirSync(ephemeralBin, { recursive: true });
    writeEphemeralCtx(ephemeralBin, PKG_VERSION);
    try {
      const env = isoEnv(s.prefix, s.home);
      // Seed the OLD persistent global install (the reported starting state).
      expect(npmInstallGlobal(old, env)).toBe(0);
      expect(installedVersion(s.prefix)).toBe("0.2.3");

      // Simulate npx: PREPEND the ephemeral cache bin ahead of everything else.
      const npxEnv = { ...env, PATH: [ephemeralBin, env.PATH].join(delimiter) };

      // Trap sanity: the RAW npx PATH resolves the ephemeral shim first (0.2.3 bug
      // source)... but the PERSISTENT PATH (what setup uses) resolves the real global.
      expect(whichSync("ctx", npxEnv.PATH)?.startsWith(ephemeralBin)).toBe(true);
      expect(whichSync("ctx", persistentPath(npxEnv.PATH))?.toLowerCase()).toContain(
        binDirFor(s.prefix).toLowerCase(),
      );

      const result = runSetup({
        env: npxEnv,
        version: PKG_VERSION,
        claudeHome: s.claudeHome,
        packageRoot: pub,
      });

      // Must UPGRADE the persistent CLI — never fall for the ephemeral "already current".
      expect(result.globalInstall).toBe("upgraded");
      expect(result.previousVersion).toBe("0.2.3");
      expect(result.installedVersion).toBe(PKG_VERSION);
      expect(result.verified).toBe(true);
      expect(result.ok).toBe(true);
      // Independent proof: the persistent launcher ON DISK is now the running version.
      expect(installedVersion(s.prefix)).toBe(PKG_VERSION);
    } finally {
      s.cleanup();
      rmSync(pub, { recursive: true, force: true });
      rmSync(old, { recursive: true, force: true });
      rmSync(npxRoot, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "F. an existing user database survives the upgrade (data preserved + migrated)",
  () => {
    if (!ready) return console.warn("[setup-packed] skipped: npm/node/dist unavailable.");
    const s = scratch();
    const pub = publishedDir();
    const old = fakeOld("0.2.3");
    try {
      const env = isoEnv(s.prefix, s.home);
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

      npmInstallGlobal(old, env);
      const result = runSetup({ env, version: PKG_VERSION, claudeHome: s.claudeHome, packageRoot: pub });
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
      rmSync(pub, { recursive: true, force: true });
      rmSync(old, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
