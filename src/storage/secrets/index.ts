import type { CtxPaths } from "../paths.ts";
import type { SecretStore } from "./types.ts";
import { FileSecretStore } from "./file-backend.ts";

export type { SecretStore } from "./types.ts";
export { envVarSecretRef } from "./types.ts";

/**
 * Returns the secret backend for the current platform. Today this is always the
 * encrypted-file backend; a future OS-keychain backend would be selected here.
 */
export function createSecretStore(paths: CtxPaths): SecretStore {
  return new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
}
