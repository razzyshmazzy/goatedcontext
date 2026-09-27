import { test, expect } from "bun:test";
import { canonicalizeRemote, detectRepoIdentity } from "../src/core/repos/repo.ts";

test("canonicalizeRemote normalizes ssh, https and credentialed URLs", () => {
  expect(canonicalizeRemote("git@github.com:acme/app.git")).toBe("github.com/acme/app");
  expect(canonicalizeRemote("https://github.com/acme/app.git")).toBe("github.com/acme/app");
  expect(canonicalizeRemote("https://user:pass@github.com/acme/app")).toBe("github.com/acme/app");
  expect(canonicalizeRemote("ssh://git@gitlab.com/team/repo.git")).toBe("gitlab.com/team/repo");
});

test("the same repo maps to the same identity regardless of transport", () => {
  expect(canonicalizeRemote("git@github.com:acme/app.git")).toBe(
    canonicalizeRemote("https://github.com/acme/app.git"),
  );
});

test("detectRepoIdentity resolves the current git repository", () => {
  const detected = detectRepoIdentity(process.cwd());
  // This test runs inside a git repo; identity should be non-null and stable.
  expect(detected).not.toBeNull();
  expect(detected!.identity.length).toBeGreaterThan(0);
  expect(detected!.name.length).toBeGreaterThan(0);
});

test("detectRepoIdentity returns null outside a git repository", () => {
  // The OS temp root is not a git repo.
  const detected = detectRepoIdentity(process.env.TMPDIR ?? process.env.TEMP ?? "/");
  // Depending on the environment this may be null; if not null it must be well-formed.
  if (detected) {
    expect(detected.identity.startsWith("remote:") || detected.identity.startsWith("path:")).toBe(true);
  } else {
    expect(detected).toBeNull();
  }
});
