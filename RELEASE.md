# Releasing goatedcontext

Maintainer-only. The published npm package is what powers `npx goatedcontext setup`.

## What ships

The package is `goatedcontext` (the CLI installs two bins: `goatedcontext` and `ctx`).
Only the built bundle and metadata are published — see the `files` field in
`package.json`:

- `dist/index.js` — the bundled CLI (Node ESM, shebang `#!/usr/bin/env node`)
- `README.md`, `ARCHITECTURE.md`, `LICENSE`, `package.json`

Source, tests, and scratch files are intentionally excluded.

## Runtime model

- **Development/tests** run under Bun (`bun:sqlite`).
- **Published CLI** runs under Node ≥ 20 using `better-sqlite3` (a normal
  dependency with prebuilt native binaries). Bun is never required at runtime.

The SQLite backend is chosen at runtime in `src/storage/sqlite/driver.ts`; the
build marks `better-sqlite3` and `bun:sqlite` as external so neither is inlined.

## Before publishing

`prepublishOnly` runs the full gate automatically (`typecheck` → `bun test` →
`build`), and `prepack` rebuilds `dist/`. You can run them by hand first:

```bash
bun run typecheck
bun test
bun run build
```

## Verify the artifact

```bash
npm pack                    # produces goatedcontext-<version>.tgz (runs prepack → build)
tar -tzf goatedcontext-*.tgz   # confirm only dist/ + docs + package.json are present
```

Then install the tarball into a throwaway prefix and drive it with plain Node to
confirm a clean-machine experience (no repo, no Bun):

```bash
npm install -g ./goatedcontext-<version>.tgz --prefix /tmp/ctx-check
CTX_HOME=/tmp/ctx-home /tmp/ctx-check/bin/ctx setup   # (Windows: /tmp/ctx-check/ctx.cmd)
CTX_HOME=/tmp/ctx-home /tmp/ctx-check/bin/ctx status
```

## Version

Bump the version in **both** `package.json` and the `VERSION` constant in
`src/cli/index.ts` (they must match — `ctx setup` uses the version to decide when
to upgrade a global install). Use semver; this packaging work is `0.2.0`.

## First publish

The name `goatedcontext` is available on npm as of this writing. Publishing
requires an authenticated npm account (2FA if enabled on the account).

```bash
npm login          # authenticate (interactive; may prompt for a one-time code)
npm whoami         # confirm you're logged in as the intended user
npm pack           # final sanity check of the tarball contents
npm publish        # publish the package publicly
```

Never commit npm credentials to this repository. `npm publish` reads auth from
your local npm config / keychain, not from the repo.

After the first publish, `npx goatedcontext setup` works for everyone.
