import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "../src/storage/secrets/index.ts";
import { DpapiSecretStore } from "../src/storage/secrets/dpapi-backend.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { ensureHome } from "../src/storage/config.ts";

// Platform-aware secret-backend behavior. Each OS in CI exercises the branch that
// actually applies to it: Windows exercises DPAPI; macOS/Linux exercise the honest
// file fallback. The key invariant is that the fallback NEVER claims to be a native
// secure keychain when it is not.

function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), "ctx-secbackend-"));
  const p = resolvePaths({ CTX_HOME: home });
  ensureHome(p); // create the secrets directory
  return { p, home };
}

test("the file backend is always available and honestly reports it is NOT a keychain", () => {
  const { p, home } = freshPaths();
  const store = createSecretStore(p, { CTX_SECRET_BACKEND: "file" });
  expect(store.backend).toBe("encrypted-file");
  const info = store.describe();
  expect(info.secure).toBe(false); // must not pretend to be secure
  expect(info.note.toLowerCase()).toContain("keychain");
  // Still round-trips a value correctly.
  store.set("k", "v");
  expect(store.get("k")).toBe("v");
  rmSync(home, { recursive: true, force: true });
});

// Generous timeout: the Windows branch spawns powershell.exe for DPAPI probes/round-trips
// (slow cold-start, and starved under parallel CI load), which overruns the 5s default.
test(
  "auto selection matches the platform's real capability",
  () => {
    const { p, home } = freshPaths();
    const store = createSecretStore(p, {}); // auto
    const info = store.describe();
    if (process.platform === "win32" && DpapiSecretStore.isAvailable()) {
      // Windows with DPAPI: a real, keyless-on-disk secure backend.
      expect(store.backend).toBe("windows-dpapi");
      expect(info.secure).toBe(true);
      store.set("k", "dpapi-secret");
      expect(store.get("k")).toBe("dpapi-secret"); // real DPAPI round-trip
    } else {
      // No native secure storage available yet on this platform: fall back honestly.
      expect(store.backend).toBe("encrypted-file");
      expect(info.secure).toBe(false);
    }
    rmSync(home, { recursive: true, force: true });
  },
  30_000,
);

test(
  "requesting DPAPI where it is unavailable fails loudly rather than pretending",
  () => {
    const { p, home } = freshPaths();
    if (process.platform === "win32") {
      if (DpapiSecretStore.isAvailable()) {
        const store = createSecretStore(p, { CTX_SECRET_BACKEND: "dpapi" });
        expect(store.backend).toBe("windows-dpapi");
      }
    } else {
      // macOS/Linux: dpapi is not real here, so selecting it must throw — never
      // silently degrade to a fake "secure" backend.
      expect(() => createSecretStore(p, { CTX_SECRET_BACKEND: "dpapi" })).toThrow();
    }
    rmSync(home, { recursive: true, force: true });
  },
  30_000,
);
