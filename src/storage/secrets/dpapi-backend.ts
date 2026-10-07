import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { SecretStore, SecretBackendInfo } from "./types.ts";
import { CorruptSecretStoreError, assertUsableEnvValue } from "./types.ts";
import { writeFileAtomic, withFileLock } from "../../utils/fs.ts";

/**
 * Windows DPAPI secret backend.
 *
 * Values are protected with the Windows Data Protection API scoped to the current
 * user (`CryptProtectData`, CurrentUser). The protection key is derived from the
 * user's logon secret and managed by the OS — ctx never stores a key on disk.
 * This removes the "encryption key colocated with data" weakness of the file
 * backend: the on-disk `secrets.dpapi.json` blobs cannot be decrypted by another
 * user, and copying them to another machine makes them useless.
 *
 * Implementation calls PowerShell's System.Security.Cryptography.ProtectedData.
 * We shell out (rather than bundle native code) so there is no homemade crypto.
 */
export class DpapiSecretStore implements SecretStore {
  readonly backend = "windows-dpapi";
  private readonly file: string;
  private readonly lockFile: string;

  constructor(file: string) {
    this.file = file;
    this.lockFile = file + ".lock";
  }

  describe(): SecretBackendInfo {
    return {
      backend: this.backend,
      secure: true,
      note:
        "Protected by Windows DPAPI (CurrentUser scope). No encryption key is " +
        "stored on disk; blobs are bound to this user account and machine.",
    };
  }

  /** Round-trip probe used for backend selection. */
  static isAvailable(): boolean {
    try {
      const blob = dpapi("Protect", Buffer.from("ctx-probe", "utf8").toString("base64"));
      if (blob == null) return false;
      const back = dpapi("Unprotect", blob);
      if (back == null) return false;
      return Buffer.from(back, "base64").toString("utf8") === "ctx-probe";
    } catch {
      return false;
    }
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      throw new CorruptSecretStoreError(this.file);
    }
    if (raw.trim().length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt store must NEVER be collapsed to empty and overwritten.
      throw new CorruptSecretStoreError(this.file);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CorruptSecretStoreError(this.file);
    }
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") throw new CorruptSecretStoreError(this.file);
    }
    return parsed as Record<string, string>;
  }

  private writeAll(entries: Record<string, string>): void {
    writeFileAtomic(this.file, JSON.stringify(entries, null, 2) + "\n", 0o600);
  }

  set(ref: string, value: string): void {
    assertUsableEnvValue(value);
    const blob = dpapi("Protect", Buffer.from(value, "utf8").toString("base64"));
    if (blob == null) throw new Error("DPAPI protect failed");
    withFileLock(this.lockFile, () => {
      const entries = this.readAll();
      entries[ref] = blob;
      this.writeAll(entries);
    });
  }

  get(ref: string): string | null {
    const blob = this.readAll()[ref];
    if (!blob) return null;
    const back = dpapi("Unprotect", blob);
    if (back == null) return null;
    return Buffer.from(back, "base64").toString("utf8");
  }

  has(ref: string): boolean {
    return Boolean(this.readAll()[ref]);
  }

  delete(ref: string): void {
    withFileLock(this.lockFile, () => {
      const entries = this.readAll();
      if (ref in entries) {
        delete entries[ref];
        this.writeAll(entries);
      }
    });
  }
}

/**
 * Run a DPAPI Protect/Unprotect via PowerShell. Input and output are base64 so
 * no binary passes through argument parsing. Returns base64 output or null on
 * failure. Secret bytes travel via stdin/stdout only — never as CLI arguments.
 */
function dpapi(op: "Protect" | "Unprotect", inputB64: string): string | null {
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    "$i=[Console]::In.ReadToEnd().Trim();" +
    "$b=[Convert]::FromBase64String($i);" +
    `$o=[System.Security.Cryptography.ProtectedData]::${op}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    "[Console]::Out.Write([Convert]::ToBase64String($o))";
  try {
    const proc = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { input: Buffer.from(inputB64, "utf8"), windowsHide: true },
    );
    if (proc.status !== 0) return null;
    const out = (proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
