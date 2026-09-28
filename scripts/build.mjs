// Build the published, Node-runnable CLI bundle.
//
// Development uses Bun, but the published artifact must run on plain Node. We
// bundle to a single ESM file and mark the native/runtime SQLite bindings as
// external so:
//   - `better-sqlite3` (the Node backend) is required from node_modules at runtime
//   - `bun:sqlite` is never pulled into the Node bundle (it's only reached under Bun)
//
// Then we rewrite the shebang to Node and mark the file executable.

import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "dist", "index.js");

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
}

// 1. Typecheck (parity with the previous build step).
run("tsc", ["--noEmit"]);

// 2. Bundle for Node, keeping the SQLite bindings external.
run("bun", [
  "build",
  "./src/index.ts",
  "--outdir",
  "dist",
  "--target",
  "node",
  "--format",
  "esm",
  "--external",
  "better-sqlite3",
  "--external",
  "bun:sqlite",
]);

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
