# `ctx` Dogfood Report

A hands-on product test of `ctx` used the way a coding agent would use it across
multiple repositories. Every result below is **observed behavior** from actually
running the CLI, not a reading of the source.

---

## Executive summary

`ctx` is a **solid, correctly-built plumbing layer with a weak retrieval brain.**
The storage, scoping, precedence mechanics, preference lifecycle, environment
secret isolation, and the Claude installer all work reliably and did exactly what
they claim. Init is idempotent, repo identity is stable across subdirectories,
repo preferences never leaked across repos, and no secret value ever appeared in
any normal output or in SQLite.

What would be **annoying or risky today**:

- **Retrieval barely discriminates.** `ctx get` returned ~12 preferences for
  *every* query — including trivial, unrelated ones ("change the color of a
  button" returned PostgreSQL and payment-service rules). Most results share an
  identical base relevance of `0.25`, so ranking is often decided by accidental
  token overlap (the word "add" in a task matches "…adding…" in unrelated rules).
  The headline promise — *the right context at the right time* — is only weakly
  delivered.
- **A correctness bug in learning:** proposing **"Never use Redis."** silently
  **merged into "Use Redis."** and *raised its confidence*. Contradictory
  corrections collapse into one rule because negation words are stripped during
  normalization. This can quietly corrupt a developer's learned preferences.
- **Semantic conflicts aren't resolved.** Global "prefer pnpm" vs repo "must use
  npm" both came back, with the *global* rule ranked above the repo rule. Repo
  override only works when the two rules are phrased with similar words.
- **Two input-validation holes:** an invalid `--scope bogus` and an empty rule
  string were both accepted and stored (the bogus-scope row is then permanently
  unretrievable).

None of these are architectural; they're localized to the similarity/retrieval
and validation code. For a **single developer who understands the limits**, `ctx`
is usable today. It is **not** ready to be handed to other people until retrieval
relevance and the dedup false-merge are fixed.

**Answers to the 10 questions:**

| # | Question | Verdict |
|---|----------|---------|
| 1 | Relevant context retrieved at the right times? | **Weak** — often present but rarely ranked/isolated by relevance |
| 2 | Irrelevant preferences filtered out? | **No** — no filtering; ~12 returned regardless |
| 3 | Repo prefs override global? | **Partial** — yes if lexically similar; **no** for the pnpm/npm case |
| 4 | `ctx propose` learns without noise? | **Mixed** — accretes evidence well, but false-merges opposites and leaves true duplicates |
| 5 | Explicit stronger/more reliable than inferred? | **Yes** — explicit=approved conf 1.0; proposals gated behind review |
| 6 | Switching repos preserves globals, changes repo behavior? | **Yes** — verified, no leakage |
| 7 | Secrets isolated from context output? | **Yes** — verified across all surfaces |
| 8 | Claude adapter installed correctly & likely to trigger? | **Install: yes. Trigger: plausible but unverifiable here** |
| 9 | Error messages & ergonomics good enough for daily use? | **Mostly** — good errors; validation gaps; PowerShell `env run` broken |
| 10 | Highest-value fixes? | See [Highest-value changes](#highest-value-changes) |

---

## Test environment

| Item | Value |
|------|-------|
| OS | Microsoft Windows 11 Home, 10.0.26200 |
| Runtime | Bun 1.4.2, Node v24.14.0 |
| Shell | Git Bash (POSIX) — used to preserve `--`; PowerShell eats standalone `--` |
| Commit under test | `ab5123c771dc75394dbdf2c1c35945c94a31264c` |
| Test CTX_HOME | `C:/Users/.../Temp/ctx-dogfood/ctxhome` (isolated; real profile untouched) |
| Fake repos | `payments-app`, `mobile-app` (git init + fake `origin` remotes) |
| Scale test | 130 preferences / 531 evidence rows |

Automated suite **before** manual test: `43 pass / 0 fail`, typecheck exit `0`.
Automated suite **after** manual test: `43 pass / 0 fail`, typecheck exit `0`,
`git status` clean (no source modified during testing).

---

## Results by area

### Initialization — works
`ctx init` created `ctx.db` + `config.json`; a second `ctx init` left config
byte-identical (idempotent). Deleting `CTX_HOME` and running any command silently
recreates an empty home (graceful). Minor cosmetic: the printed home path mixes
forward/back slashes.

### Preferences — works
All 10 global preferences were stored as `approved`, `confidence 1.00`, correct
categories. `ctx prefs` output is compact and readable (`shortid [status]
(scope/category) c=… rule`).

### Retrieval relevance — weak (see table)
`ctx get` returned 12 of 16 (and later 12 of 130) preferences for every query.
There is **no relevance threshold** — it returns `min(limit, candidates)`
regardless of whether anything is actually relevant. The relevance score is
dominated by a constant base (`0.25` for approved global) so most results tie, and
tie-breaking falls to precedence or to spurious lexical overlap. Verified root
cause: `normalize("Add formatting…")="add formatt timestamp transaction"` shares
only the filler token **"add"** with `"…before adding defensive workarounds"`,
which was enough to rank the root-cause rule #1 for several "Add …" tasks.

### Cross-repo behavior — works
`ctx get --task "Add persistence for a new record type"` returned each repo's own
three repo rules plus globals, with **zero cross-repo leakage** in either
direction (verified by parsing `preferences[]`, not raw text). Nested subdirectory
resolved to the same repo id as the root.

### Precedence — works (when conflicts are detected)
Verified directly against the documented hierarchy using lexically-similar pairs:

| Scenario | Winner | Correct? |
|----------|--------|----------|
| locked **global** vs approved **repo** | approved repo | ✅ (repo rank 2 < global rank 3) |
| approved **global** vs locked **repo** | locked repo | ✅ (rank 1) |
| rejected rule | excluded entirely (also gone from `overridden`) | ✅ |

**But** conflict *detection* is purely lexical: global "Prefer pnpm for JavaScript
projects." and repo "This repository must use npm." were **both** returned, pnpm
ranked above npm. Repo override silently fails whenever the two rules don't share
enough words.

### Proposal / dedup behavior — mixed, one critical bug
- Evidence accretion works: a similar re-proposal appended evidence and bumped
  confidence `0.50 → 0.60`.
- **Critical false-merge:** "Use Redis." and "Never use Redis." both normalize to
  `"redi"` (similarity `1.000`) → merged into one "Use Redis." proposal now
  carrying the contradictory evidence *"User said do not add Redis."* and higher
  confidence.
- **Too weak elsewhere:** three genuinely-equivalent helper-function corrections
  (`score ≈ 0.18`, below the `0.6` threshold) stayed as three separate pending
  proposals → review noise.

### Lifecycle — works
`why → approve → appears in get`; `reject → absent even with --include-proposed`;
`forget → removed`; `why <forgotten>` → friendly error, exit 4. Understandable.

### Environments — works
`add / set / list / vars / run / remove` all worked. Child process received
secrets (`OPENAI len=19, startswith fake-`); composition worked
(`ctx env run supabase-test openai-dev -- …` injected both). `env list`/`vars`
show variable **names** and availability only.

### Secret isolation — verified strong (with a real limit)
No plaintext of `fake-anon-key-123` / `fake-openai-key-456` in `ctx get`,
`ctx prefs`, `ctx env list/vars`, or raw `ctx.db`. `secrets.json` is AES-256-GCM
ciphertext. See [Security findings](#security-findings) for the key-colocation
limitation (demonstrated).

### Error handling — mostly good
Good, recoverable messages with sensible exit codes for missing ids/envs (exit 4)
and duplicate envs (exit 1). Two silent-accept holes (invalid scope, empty rule).
`ctx get` dumps a raw stack trace on `EPIPE` when a downstream consumer closes the
pipe early.

### Performance — fine at tested scale
At 130 prefs / 531 evidence, `ctx get` ≈ **~200 ms** per call; pure cold start
(`ctx --version`) ≈ **~145 ms**. So retrieval logic adds only ~55 ms; most latency
is Bun/TS cold start. No pathological scaling observed (conflict resolution is
O(n²) over the candidate set and `list()` loads all rows each call — negligible at
hundreds, worth watching at tens of thousands).

### Automated tests — green
`bun test` → 43 pass / 0 fail, before and after. `bun run typecheck` → exit 0.

---

## Retrieval quality table

Relevance ordering as returned; "top" = the highest-ranked results.

### Repo A — payments-app

| Query | Expected relevant | Actual (top) | Irrelevant returned | Missing/buried | Verdict |
|-------|-------------------|--------------|---------------------|----------------|---------|
| Add formatting for transaction timestamps. | (weakly) none strong | #1 "Find the root cause…" (spurious "add") | ~11 unrelated (all 12 returned) | — | **fail** |
| Design persistence for settlement records. | uses PostgreSQL; relational constraints | present at #3/#4 but tied at r=0.25 | rest of 12 | DB rules not *ranked* as relevant | **weak** |
| Add a retry mechanism for failed payment requests. | Extend payment service; root-cause | #2 Extend payment service ✅; #1 root-cause (spurious) | many | — | **weak** |
| Change the color of the settings button. | ~none (backend repo) | 12 prefs all r=0.25 incl. PostgreSQL | all 12 | — | **fail** |
| Install a library to left-pad transaction IDs. | Check existing deps; avoid trivial dep; repo dep-justification | #1 Check existing deps ✅ | many | avoid-trivial-dep & repo dep-justification stuck at 0.25 | **weak** |

### Repo B — mobile-app

| Query | Expected relevant | Actual (top) | Irrelevant returned | Missing/buried | Verdict |
|-------|-------------------|--------------|---------------------|----------------|---------|
| Store local user preferences. | UI state local; simple local arch; SQLite local | #1 UI state local ✅, #2 simple local ✅ | rest of 12 | SQLite-local buried at 0.25 | **pass/weak** |
| Add an app-wide loading state. | UI state local | #2 UI state ✅; #1 root-cause (spurious) | many | — | **weak** |
| Format a date label. | ~none strong | all r=0.25 | all 12 | — | **weak/fail** |
| Add a networking retry helper. | avoid one-use helpers; platform-native | #4 helper-functions ✅; #1 root-cause (spurious) | many | platform-native buried | **weak** |
| Install a UI component library for a single button. | Check existing deps; platform-native; UI state | #1 deps ✅, #2 platform-native ✅, #3 UI state ✅ | rest | — | **pass** |

**Pattern:** relevant rules are usually *present* but rarely *isolated* — they sit
in a 12-item dump at a tie score, and the #1 slot is frequently a spurious match.
Two queries (dependency-install, store-local) worked well because task keywords
happened to align with rule keywords.

---

## Bugs

> Per instructions, these were reproduced and recorded, **not** fixed.

### BUG-1 — Contradictory proposals merge, losing negation — **critical**
- **Repro:**
  ```
  ctx propose --category infrastructure --evidence "introduced Redis" "Use Redis."
  ctx propose --category infrastructure --evidence "do not add Redis"  "Never use Redis."
  ```
- **Expected:** two distinct proposals (or a detected conflict).
- **Actual:** second merged into the first; `ctx prefs pending` shows one "Use
  Redis." proposal, confidence `0.60`, evidence includes *"User said do not add
  Redis."*
- **Cause:** `JaccardSimilarity.normalize` drops stopwords ("never", "use", "not")
  and stems "Redis." → "redi", so both strings normalize to `"redi"` (score
  1.000, ≥ the `0.6` merge threshold in `PreferenceService.findSimilarProposal`).
  Negation/polarity is not represented.

### BUG-2 — `ctx get` performs no relevance filtering — **high**
- **Repro:** `ctx get --cwd <repoA> --task "Change the color of the settings button"`
- **Expected:** few or zero relevant preferences for a backend repo.
- **Actual:** 12 preferences returned, all at `relevance 0.25`, including
  PostgreSQL and payment-service rules.
- **Cause:** `RetrievalEngine.retrieve` sorts then `slice(0, limit)` with no
  minimum-relevance cutoff; base score (`0.15*confidence + statusWeight`) makes
  most items tie at 0.25.

### BUG-3 — Semantic conflicts not resolved; global can outrank repo — **high**
- **Repro:**
  ```
  ctx remember --scope global --category dependencies "Prefer pnpm for JavaScript projects."
  ctx remember --scope repo   --category dependencies "This repository must use npm."
  ctx get --task "Add a new dependency for date parsing"
  ```
- **Expected:** repo "npm" wins / global "pnpm" suppressed.
- **Actual:** both returned; **pnpm (global) ranked above npm (repo)**;
  `overridden` empty for this pair.
- **Cause:** conflict detection requires same category **and** lexical similarity
  ≥ `0.55`; "pnpm/javascript" vs "npm/repository" score far below that.

### BUG-4 — Spurious ranking from filler tokens ("add") — **medium**
- **Repro:** any task beginning "Add …" ranks rules containing "adding" to the top
  (e.g. "Find the root cause before adding defensive workarounds." at #1 for "Add
  formatting for transaction timestamps.").
- **Cause:** "add" is not a stopword; short tasks + terse rules make a single
  shared filler verb dominate the small non-base score.

### BUG-5 — Invalid `--scope` accepted and stored — **medium**
- **Repro:** `ctx remember --scope bogus --category x "some rule"` → exit 0,
  stores a row with `scope=bogus`.
- **Expected:** rejection with a clear error.
- **Actual:** created; and because retrieval only matches `scope in (global,repo)`,
  the row is **permanently unretrievable** (silent black hole).
- **Cause:** `PreferenceService.remember` doesn't validate against the Zod `Scope`
  enum; `validateScope` only special-cases the `repo`/`global` branches.

### BUG-6 — Empty rule text accepted — **medium**
- **Repro:** `ctx remember --scope global --category x ""` → exit 0, stores an
  empty-rule preference (which then appears in `ctx get`).
- **Cause:** the Zod `Preference.rule.min(1)` schema is not enforced on the write
  path.

### BUG-7 — Dedup too weak for equivalent corrections — **low**
- **Repro:** the three helper-function proposals in Phase 7 stayed separate
  (pairwise similarity ≈ 0.18 < 0.6).
- **Effect:** review-queue noise; three pending items for one idea.

### BUG-8 — Stack trace leaked on broken pipe — **low**
- **Repro:** pipe `ctx get` into a consumer that exits early → `ctx` prints an
  `EPIPE` stack trace from `printJson`.
- **Effect:** ugly, leaks internal paths; harmless to data.

### BUG-9 — Intended `0600` secret perms not applied on Windows — **low**
- **Observed:** `secret.key` and `secrets.json` show mode `-rw-r--r--` (644); the
  `chmod` to `0600` is silently swallowed on this filesystem. No OS-level read
  restriction is actually in place.

---

## Product friction (not bugs)

- **`ctx env run` is unusable from PowerShell** — the primary platform's default
  shell consumes the standalone `--`, so `ctx env run test-api -- npm test`
  reaches the CLI as `... npm test` and errors on `unknown option`. Works in Git
  Bash. This is a real daily-driver problem on Windows and deserves a documented
  workaround or a `--cmd` alternative.
- **`ctx get` output is a wall of JSON** — 12 objects × 7 fields even for trivial
  tasks. An agent must wade through mostly-irrelevant rules; combined with BUG-2
  this actively trains the agent to ignore the tool.
- **Retrieval demands keyword alignment** — tasks phrased differently from the
  stored rule wording miss otherwise-relevant preferences.
- **Proposal review is one-at-a-time** and can fill with near-duplicates (BUG-7);
  no `ctx prefs pending` grouping/merge affordance.
- **Setting a secret** requires `--value` (shell-history exposure) or `--from-env`;
  there's no interactive/stdin prompt, so the safe path is the less obvious one.
- **Service-level filters aren't exposed** — `list({status,scope,repoId})` exists
  in code but `ctx prefs` has no `--scope/--status/--category` flags.

---

## Security findings

**Verified protections**
- Secret **values** never appeared in `ctx get`, `ctx prefs`, `ctx env list`,
  `ctx env vars`, or the raw `ctx.db` file (grepped the binary).
- `secrets.json` stores only `{iv, tag, data}` AES-256-GCM ciphertext per ref.
- SQLite `environment_variables` holds only `var_name` + opaque `secret_ref`.
- `ctx env run` injects values into the child process only; `ctx` prints none.

**Limitations (confirmed, not theoretical)**
- **Key colocation:** `secret.key` sits in the same directory as `secrets.json`.
  A one-file attacker script that reads both **recovered every fake secret**
  (demonstrated in Phase 9). This is *not* equivalent to OS-keychain storage and
  should not be described as such.
- **No effective file permissions on Windows** (BUG-9): the intended `0600` is not
  applied, so the guard is process-model/ACL-dependent, not enforced by `ctx`.

**Risks worth flagging**
- **Cloud-sync exposure:** the default home is `~/.ctx`, and on this machine the
  user profile is under **OneDrive**. If `~/.ctx/secrets/` ever lands in a synced
  path, *both* key and ciphertext sync to the cloud together — full compromise on
  any synced device. `ctx` should warn if `CTX_HOME` resolves under a known sync
  root.

**Not tested**
- Concurrent access / DB locking, secret rotation, corrupted-key recovery
  (`get` returns null → `env run` errors, but not exercised), and any keychain
  backend (none exists yet).

---

## Claude-adapter assessment

- **Installation: correct.** `ctx install claude` wrote `context`,
  `context-learn`, `context-env` under `<claude-home>/skills/…/SKILL.md`, inserted
  a single marker-delimited block into `CLAUDE.md`, and was **idempotent**
  (`updated` then `unchanged`; exactly one `ctx:begin`). Pre-existing user
  instructions ("Always prefer verbose logging.") were preserved.
- **Skills are well structured.** Thin shims that call the CLI (`context`: 1,
  `context-learn`: 2, `context-env`: 6 invocation references); no SQL, precedence,
  or crypto logic duplicated. `context-learn` explicitly prohibits storing secrets.
- **Auto-invocation: plausible but unverified.** I could not spawn a live Claude
  Code session bound to the temp `claude-home` in this environment, so this is a
  **static** assessment. The `context` skill description is reasonably strong
  ("BEFORE any consequential engineering decision" + an explicit list). Two
  caveats: (a) model-driven skill selection is inherently probabilistic; (b) even
  when it fires, BUG-2's noisy 12-item output undercuts the payoff, so the agent
  may learn the tool is low-value.
- **Suggested wording changes:** tell the model the output is
  *precedence-ordered and pre-filtered* (once it actually is), and add one concrete
  worked example of a `ctx get` call + how to apply the top rules. Consider a
  short "if 0 relevant, proceed normally" line to avoid over-calling on trivial
  tasks.

---

## Highest-value changes

Ordered by expected improvement to real daily use.

### 1. Make retrieval actually selective (fixes BUG-2, BUG-4; the core pitch)
- **Problem:** `ctx get` returns ~12 prefs for everything at a tie score; the #1
  slot is often a spurious filler-token match. The product's whole value is
  "right context at the right time," and that isn't happening.
- **Fix:** introduce a real relevance signal (TF-IDF / IDF-weighted overlap so
  common verbs like "add" count for little; drop the flat base score's dominance),
  add a **minimum-relevance cutoff** so irrelevant rules are omitted, and return a
  variable count (0–N) instead of always filling to `limit`. Keep the
  `Similarity` seam for future embeddings.
- **Why:** turns a noisy dump into trustworthy, act-on-able context — the single
  biggest lever on whether an agent (and a human) keeps using `ctx`.

### 2. Fix dedup polarity so opposites never merge (fixes BUG-1)
- **Problem:** "Use Redis" and "Never use Redis" collapse into one rule and the
  wrong one gains confidence — silent corruption of learned preferences.
- **Fix:** stop discarding negation/polarity in `normalize` (keep never/no/not/
  avoid/don't and factor a polarity sign into merge eligibility); require matching
  polarity before merging. Separately, raise recall for *true* duplicates
  (helper-function case) once polarity is safe.
- **Why:** a learning system that merges corrections with their opposites is worse
  than no learning; this is a trust-breaking correctness issue.

### 3. Enforce write-path validation (fixes BUG-5, BUG-6)
- **Problem:** invalid scope and empty rules are stored; bad-scope rows become
  unretrievable ghosts.
- **Fix:** validate `remember`/`propose` inputs through the existing Zod schemas
  (`Scope`, `Preference.rule.min(1)`) and return clear CLI errors.
- **Why:** cheap, prevents silent data corruption and confusing "I saved it but it
  never shows up" reports.

### 4. Category/topic-aware conflict resolution (fixes BUG-3)
- **Problem:** repo rules only override global ones when phrased similarly; the
  canonical pnpm-vs-npm case fails.
- **Fix:** detect conflicts by shared *topic/subject* (e.g. category + a small
  extracted key noun) rather than raw lexical similarity, so repo precedence
  applies to semantically-opposed rules too.
- **Why:** "repo overrides global" is a headline guarantee; today it's fragile.

### 5. Windows/secret hardening + robustness (fixes BUG-8, BUG-9, sync risk; PowerShell friction)
- **Problem:** `env run` is broken under PowerShell; `0600` doesn't apply on
  Windows; key colocated with data; home may live under OneDrive; `EPIPE` leaks a
  stack trace.
- **Fix:** add a PowerShell-friendly invocation (e.g. `ctx env run <env> --cmd
  "npm test"` or document `--%`); set real ACLs on Windows; warn when `CTX_HOME`
  is under a sync root; handle `EPIPE` quietly; plan an OS-keychain backend behind
  the existing `SecretStore` interface.
- **Why:** the primary platform is Windows; the default daily commands and the
  security story both need to hold up there.

---

## Ship recommendation

### ✅ Ready for **private dogfooding** (single owner who knows the caveats)

**Why not "limited external alpha" yet:** two issues would bite unfamiliar users.
BUG-1 (contradictory proposals merging and boosting confidence of the wrong rule)
can silently corrupt the very preference memory the product exists to build, and
BUG-2/BUG-4 mean the flagship `ctx get` currently returns a noisy, weakly-ranked
dump that undersells the tool and could train agents to ignore it. Neither is
architectural, but both are trust issues.

**Why it clears the bar for private dogfooding:** the foundation is genuinely
sound and verified — idempotent init, correct scoping with zero cross-repo
leakage, correct precedence when conflicts are detected, a clean and
understandable lifecycle, real secret isolation (no plaintext anywhere it
shouldn't be), a correct idempotent Claude installer, and a green test/typecheck
suite before and after heavy manual use. An informed owner can use it daily,
phrase tasks with rule-aligned keywords, review proposals carefully, and avoid the
PowerShell `env run` path.

**Do not consider external alpha until at least changes #1 and #2 land**, and a
public launch is not supported by this evidence.
