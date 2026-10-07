import { test, expect } from "bun:test";
import { redactRemoteUrl, canonicalizeRemote, detectRepoIdentity } from "../src/core/repos/repo.ts";
import type { GitProbe } from "../src/utils/git.ts";
import { makeTestContext } from "./helpers.ts";
import { exportData } from "../src/core/transfer/transfer.ts";

/**
 * Git remote credential redaction (Wave 3 §22-23). A credentialed remote
 * (`https://user:TOKEN@host/...`) must never be persisted or exported in cleartext.
 */

const TOKEN = "ghp_SUPERSECRETTOKEN12345";

test("redactRemoteUrl strips userinfo from URL forms, preserves scp/ssh identity", () => {
  expect(redactRemoteUrl(`https://user:${TOKEN}@example.com/org/repo.git`)).toBe(
    "https://example.com/org/repo.git",
  );
  expect(redactRemoteUrl(`https://${TOKEN}@example.com/org/repo.git`)).toBe(
    "https://example.com/org/repo.git",
  );
  expect(redactRemoteUrl(`ssh://git:pw@example.com/org/repo`)).toBe("ssh://example.com/org/repo");
  // scp-like form: `git@` is a username, not a secret — preserved.
  expect(redactRemoteUrl("git@example.com:org/repo.git")).toBe("git@example.com:org/repo.git");
  // No-credential URLs are unchanged; null passes through.
  expect(redactRemoteUrl("https://example.com/org/repo.git")).toBe("https://example.com/org/repo.git");
  expect(redactRemoteUrl(null)).toBe(null);
});

test("identity canonicalization is unchanged by redaction", () => {
  expect(canonicalizeRemote(`https://user:${TOKEN}@github.com/acme/app.git`)).toBe("github.com/acme/app");
});

function probeWithRemote(url: string, root: string): GitProbe {
  return { toplevel: () => root, originUrl: () => url };
}

test("detectRepoIdentity stores a redacted remote URL (no token persisted)", () => {
  const d = detectRepoIdentity("/x", probeWithRemote(`https://u:${TOKEN}@github.com/acme/app.git`, "/x"));
  expect(d).not.toBeNull();
  expect(d!.remoteUrl).toBe("https://github.com/acme/app.git");
  expect(d!.remoteUrl).not.toContain(TOKEN);
  expect(d!.identity).toBe("remote:github.com/acme/app");
});

test("export redacts credentials even for a LEGACY row that already stored a token", () => {
  const t = makeTestContext();
  try {
    // Simulate a legacy repo row that still contains a credentialed remote URL, then
    // attach a repo-scoped preference so the repo is included in the export.
    const repo = t.ctx.repos.ensureByIdentity({
      identity: "remote:github.com/acme/legacy",
      name: "legacy",
      remoteUrl: `https://user:${TOKEN}@github.com/acme/legacy.git`,
      hasRemote: true,
      rootPath: "/legacy",
    });
    t.ctx.preferences.remember({ rule: "Use Bun.", scope: "repo", repoId: repo.id });

    const bundle = exportData(t.ctx);
    const json = JSON.stringify(bundle);
    expect(json).not.toContain(TOKEN); // token absent from the export entirely
    const exported = bundle.repos.find((r) => r.identity === "remote:github.com/acme/legacy");
    expect(exported?.remoteUrl).toBe("https://github.com/acme/legacy.git");
  } finally {
    t.cleanup();
  }
});
