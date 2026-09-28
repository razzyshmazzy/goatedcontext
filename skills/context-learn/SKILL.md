---
name: context-learn
description: >-
  When the developer gives a correction or expresses a reusable engineering
  preference, propose it for persistence with the `ctx` CLI so it follows them
  across repositories. Proposals are reviewed by the developer before becoming
  permanent rules.
---

# context-learn

Use this skill when the developer:

- corrects an engineering decision you made
- states a reusable preference ("prefer X", "don't use Y", "always Z")
- rejects an approach in a way that generalizes beyond the current task

## How to use

Propose the preference — do NOT mark it as permanent yourself. `ctx propose`
creates a *proposed* preference the developer reviews later. Always pass
provenance so the evidence is attributable to this agent and session:

```bash
ctx propose \
  --agent-id claude-code \
  --session-id "$CLAUDE_CODE_SESSION_ID" \
  --category <architecture|dependencies|conventions|testing|security|infrastructure|data-modeling|general> \
  --evidence "<what the developer said or did that implies this>" \
  "<the reusable rule, phrased generally, in a single terse sentence>"
```

Keep the rule short and canonical (one sentence, no extra clauses) so equivalent
corrections from different sessions can be recognized as the same preference.

Choose `--scope repo` (inside a git repo) only when the rule is specific to this
project; otherwise use the default `--scope global`.

If a similar proposal already exists, `ctx` will attach your evidence to it and
raise its confidence instead of creating a duplicate.

## Hard rule: never store secrets

Do NOT store secrets, credentials, API keys, tokens, private keys, passwords, or
environment variable VALUES as preferences. Preferences describe *how* to build
software, not sensitive data. Secret values belong only in `ctx` environments
(see the context-env skill).
