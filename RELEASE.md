# Releasing goatedcontext

Maintainer-only.

The npm package is `goatedcontext`. It installs two binaries:

```text
goatedcontext
ctx
```

The public install/upgrade path is:

```bash
npx goatedcontext setup
```

## What ships

The published package intentionally contains only the runtime bundle and public metadata defined by the `files` field in `package.json`.

Typical package contents:

- `dist/index.js`
- `README.md`
- `ARCHITECTURE.md`
- `INTEGRATING.md`
- `LICENSE`
- `package.json`

Source, tests, benchmarks, and scratch files are not published.

## Runtime model

Development and tests run under Bun.

The published CLI runs under Node ≥ 22.13 using Node's built-in `node:sqlite`.

There is no native SQLite dependency:

- no `node-gyp`
- no C++ compiler
- no Python build toolchain
- no platform-specific SQLite binary download

`src/storage/sqlite/driver.ts` selects the appropriate runtime implementation.

The build keeps `bun:sqlite` out of the Node bundle; `node:sqlite` is provided by Node itself.

## Versioning

`package.json` is the single source of truth for the release version.

Example:

```bash
npm pkg set version=0.3.0
```

The build injects that version into the CLI, so:

```bash
npm pkg get version
node dist/index.js --version
```

must agree.

Never maintain a second handwritten version constant.

Never overwrite an already-published npm version.

Before starting a release, check:

```bash
npm view goatedcontext version
npm pkg get version
```

## Release gate

Run these before publishing:

```bash
bun run build
bun run typecheck
bun test
bun run smoke:mcp        # SDK-driven MCP end-to-end against the built bundle
bun run stress           # multiprocess SQLite torture (32 readers + 8/4/4 writers)
npm publish --dry-run
```

All must succeed.

`prepublishOnly` also runs the full validation gate automatically, and `prepack` rebuilds `dist/`.

`bun run smoke:mcp` is a MAINTAINER/repo command (it runs under Bun and uses the MCP SDK
as a client). It does NOT make installed users depend on Bun: by default it validates the
shipped `node dist/index.js mcp` bundle — exactly the Node artifact end users run. There is
no hand-built JSON-RPC and no hard-coded MCP protocol version anywhere; the SDK negotiates
the protocol.

A release is not ready if:

- any test fails
- typecheck fails
- the built CLI reports the wrong version
- `npm publish --dry-run` reports the wrong version
- unexpected files appear in the package

## Inspect the package

Optional but useful:

```bash
npm pack
tar -tzf goatedcontext-*.tgz
```

Confirm the tarball contains only the intended runtime/public files.

## Important: test npx from a clean directory

Do not use the goatedcontext development repository as the authoritative test of:

```bash
npx goatedcontext@<version> ...
```

npm may prioritize the project's own local `node_modules/.bin` while inside the package repository.

Use a clean unrelated directory instead.

Example:

```bash
mkdir /tmp/ctx-public-test
cd /tmp/ctx-public-test
npx --yes goatedcontext@<version> --version
```

On Windows, use a normal temporary directory outside the goatedcontext repository.

This matters because an earlier installer regression was masked by local/npx binary resolution.

## Installer invariant

Production setup must install the persistent CLI from the exact registry package:

```text
goatedcontext@<version>
```

Never globally install the directory currently being executed by `npx`.

In particular, do not regress to behavior equivalent to:

```text
npm install -g <npx packageRoot>
```

On Windows, npm may create a global junction into the temporary `_npx` cache instead of installing a durable copy.

The installer must preserve the fixes that ensure:

- exact-version registry install
- no global junction into `_npx`
- detection/repair of previously linked installs
- persistent PATH verification
- preservation of the local ctx store
- installed-version verification
- no manual `npm install -g` requirement

## Commit before publishing

Once validation is green:

```bash
git status
git add .
git commit -m "<release message>"
git push
```

Verify the commit contains only intended release changes.

Then publish:

```bash
npm whoami
npm publish
```

Do not publish from an unreviewed dirty working tree.

Never commit npm credentials.

## Post-publish public-path verification

After `npm publish`, verify the actual registry package, not the local source tree.

From a clean unrelated directory:

```bash
npx --yes goatedcontext@<version> --version
```

Expected:

```text
<version>
```

Then install/upgrade through the real public path:

```bash
npx --yes goatedcontext@<version> setup
```

Open a fresh shell if necessary and verify:

```bash
ctx --version
ctx agents
ctx doctor
```

`ctx --version` must match the newly published version before testing any feature introduced by that release.

Do not test new release behavior against an older globally installed `ctx`.

## Agent acceptance checks

For releases touching agent integrations, use whichever agents are actually installed.

### Claude Code

Verify:

```text
ctx agents
ctx doctor
```

show healthy Claude runtime integration, memory guidance, and `permissions ✓` (the narrow
ctx command allow rules).

Use a fresh Claude session when required by the installer output.

### Codex

Verify:

```text
runtime ✓
AGENTS.md ✓
memory skill ✓
permissions ✓
```

On Windows, `ctx doctor` should also confirm the Codex ctx writable-root configuration and the runnable `ctx.cmd` command path.

Do not require Codex Full Access merely for goatedcontext memory writes — the narrow
`goatedcontext.rules` execpolicy file is sufficient.

### Cursor

Verify `ctx agents` / `ctx doctor` show the 0.4.0 runtime integration:

```text
session hook ✓    (~/.cursor/hooks.json sessionStart)
MCP               (~/.cursor/mcp.json goatedcontext server)
AGENTS.md ✓
memory skill ✓
```

Cursor has no per-prompt injection hook (`beforeSubmitPrompt` is block-only), so standing
rules are injected at `sessionStart` and per-task retrieval is via the MCP `get_context`
tool. Do not fake a per-prompt hook, and do not broaden dynamic preferences into static
rules. Note: user-level `sessionStart` hooks are unavailable to Cursor CLOUD agents (local
editor only); project-scoped `.cursor/hooks.json` + MCP remain the path there.

### MCP (universal transport)

For the repo/pre-publish gate, `bun run smoke:mcp` already drives the built bundle through
the MCP SDK (initialize → tools/list → get_context reflecting a CLI-written preference →
clean shutdown).

To validate the INSTALLED package over MCP after publish, point the same SDK-based smoke at
the globally installed launcher (from a checkout of this repo, which has the dev MCP SDK):

```bash
CTX_SMOKE_CMD=ctx bun run smoke:mcp        # POSIX
CTX_SMOKE_CMD=ctx.cmd bun run smoke:mcp    # Windows
```

Expected: `SMOKE PASS`. Do not hand-pipe raw JSON-RPC and do not hard-code an MCP protocol
version — the SDK negotiates it. Any MCP-capable host (Cursor, Claude Code, a custom client)
can equivalently add the stdio server `{ "command": "ctx", "args": ["mcp"] }`.

## Memory acceptance test

For releases touching memory behavior, the user should not need to run `ctx remember`.

In a disposable Git repo, tell the coding agent:

> Always use Bun in this repo.

Then verify:

```bash
ctx prefs --json
```

A repo-scoped durable Bun preference should exist.

Then tell the agent:

> Use npm for this one command.

Verify no durable npm preference was added.

Then:

> Actually use npm in this repo from now on.

Verify the durable repo preference is updated appropriately.

## Memory-write acceptance test — no approval prompts (0.3.5)

For releases touching the permission integration, the decisive check is that memory
writes happen in NORMAL permission mode — no `--dangerously-skip-permissions`, no Codex
Full Access.

In a disposable Git repo, in a normal agent session, say:

> Always use Supabase for the backend in this repo.

Expected, with NO broad permission bypass enabled:

- the agent does NOT ask you to approve running `ctx` just to record the memory
- exactly one `ctx` write happens (a decision-aware `ctx remember`)
- a repo-scoped durable Supabase preference exists, AND a `backend=supabase` signal exists:

```bash
ctx prefs --json
ctx signals --domain backend --json
```

Then, in a FRESH repo, say:

> Set up the backend.

Expected: the injected context surfaces the cross-repo Supabase evidence automatically
(no manual `ctx signal add` was ever run), and no preference was silently created in the
fresh repo.

Negative check — these must STILL prompt (never silently run):

- `ctx env run …`, `ctx setup`, `ctx install …`, `ctx uninstall …`
- `ctx forget …`, `ctx signal clear`, `ctx prefs approve …`
- any non-ctx command (`npm`, `node`, `powershell`, …)

If an organization ships a managed/enterprise policy that requires approval, a local
allow cannot override it — `ctx doctor` reports the rule's presence, not a guarantee the
host will honor it over a managed deny. That is expected and must be reported honestly.

## Static projection acceptance test

Repo-scoped, approved/locked, always-on preferences may be projected into `AGENTS.md`.

Verify:

```bash
ctx sync
```

and inspect `AGENTS.md`.

It must not contain:

- global preferences
- relevant preferences
- conditional preferences
- proposed preferences
- rejected preferences
- secrets

Handwritten content outside the managed goatedcontext block must remain untouched.

## 0.3.x retrieval acceptance checks

For releases affecting retrieval:

- effective always rules must not be silently dropped because of an arbitrary item count
- matching conditional rules must not be silently dropped because of an arbitrary item count
- repo isolation must remain exact
- long-lived readers must immediately observe writes from other processes
- runtime retrieval must remain cache-free unless a future release explicitly changes that architecture
- semantic output must remain deterministic
- SQLite concurrency tests must remain green

Performance changes must be backed by benchmark evidence, not timing assumptions.

## Database and migrations

Schema changes must use the existing atomic migration framework.

Required invariants:

- failed migration rolls back
- schema version is not falsely advanced
- database remains readable after failure
- migrations are resumable/idempotent where designed

Do not copy a live SQLite database naïvely while WAL is active.

If a future release adds migration backups, use a SQLite-safe strategy validated by tests.

## Release sequence

Canonical sequence:

```text
1. verify package.json version
2. build
3. typecheck
4. run full tests
5. bun run smoke:mcp and bun run stress
6. npm publish --dry-run
7. review git diff/status
8. commit
9. push
10. npm publish
11. test npx goatedcontext@<version> from a clean directory
12. run npx goatedcontext@<version> setup
13. open a fresh shell if needed
14. verify ctx --version
15. run ctx agents
16. run ctx doctor
17. perform feature-specific acceptance tests (incl. CTX_SMOKE_CMD=ctx bun run smoke:mcp)
```

A release is not complete merely because `npm publish` succeeded.

The public installation path must also work.