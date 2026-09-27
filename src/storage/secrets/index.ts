import { join } from "node:path";
import type { CtxPaths } from "../paths.ts";
import type { SecretStore } from "./types.ts";
import { FileSecretStore } from "./file-backend.ts";
import { DpapiSecretStore } from "./dpapi-backend.ts";

export type { SecretStore, SecretBackendInfo } from "./types.ts";
export { envVarSecretRef } from "./types.ts";

/**
 * Select the secret backend.
 *
 * Selection is explicit and inspectable (see `ctx status`). The `CTX_SECRET_BACKEND`
 * environment variable forces a choice:
 *   - "dpapi" — Windows DPAPI (errors if unavailable)
 *   - "file"  — encrypted-file fallback
 *   - "auto"  — (default) prefer a native OS backend, else fall back to file
 *
 * On Windows, "auto" uses DPAPI when available. On other platforms it currently
 * falls back to the encrypted-file backend (native macOS Keychain / libsecret
 * backends can be added behind this same interface later).
 */
export function createSecretStore(
  paths: CtxPaths,
  env: NodeJS.ProcessEnv = process.env,
): SecretStore {
  const choice = (env.CTX_SECRET_BACKEND ?? "auto").toLowerCase();
  const fileStore = () => new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
  const dpapiFile = join(paths.secretsDir, "secrets.dpapi.json");

  if (choice === "file") return fileStore();
  if (choice === "dpapi") {
    if (process.platform === "win32" && DpapiSecretStore.isAvailable()) {
      return new DpapiSecretStore(dpapiFile);
    }
    throw new Error("CTX_SECRET_BACKEND=dpapi requested but DPAPI is unavailable on this platform.");
  }

  // auto
  if (process.platform === "win32" && DpapiSecretStore.isAvailable()) {
    return new DpapiSecretStore(dpapiFile);
  }
  return fileStore();
}
