// Build the published, Node-runnable CLI bundle.
//
// Development uses Bun, but the published artifact must run on plain Node. We
// bundle to a single ESM file. The Node backend is `node:sqlite` (a built-in, so
// no native addon / node-gyp), and we keep `bun:sqlite` external so it is never
// pulled into the Node bundle (it's only reached under Bun).
//
// The package version is the single source of truth in package.json; we inject it
// into the bundle via `--define __CTX_VERSION__` so the artifact knows its own
// version without reading any package.json at runtime.
//
// Then we rewrite the shebang to Node and mark the file executable.

import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "dist", "index.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
}

// 1. Typecheck (parity with the previous build step).
run("tsc", ["--noEmit"]);

// 2. Bundle for Node via Bun's build API. `bun:sqlite` stays external (only
//    reached under Bun); `node:sqlite` is a Node built-in and is external
//    automatically. The version is injected as a compile-time constant — using
//    the API (not the CLI) avoids cross-platform shell quoting of `--define`.
const result = await Bun.build({
  entrypoints: [join(root, "src", "index.ts")],
  outdir: join(root, "dist"),
  target: "node",
  format: "esm",
  external: ["bun:sqlite"],
  define: { __CTX_VERSION__: JSON.stringify(pkg.version) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// 3. Ensure a Node shebang (the source shebang targets Bun for local dev).
let code = readFileSync(out, "utf8");
const shebang = "#!/usr/bin/env node";
code = code.startsWith("#!") ? code.replace(/^#![^\n]*\n/, shebang + "\n") : shebang + "\n" + code;
writeFileSync(out, code);

// 4. Make it executable (no-op semantics on Windows).
try {
  chmodSync(out, 0o755);
} catch {
  /* ignore on platforms/filesystems without POSIX modes */
}

console.log("Built dist/index.js");
