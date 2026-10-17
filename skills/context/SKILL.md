---
name: context
description: >-
  Retrieve the developer's persistent preferences and available environments
  before making consequential engineering decisions (architecture, dependencies,
  data modeling, infrastructure, security, testing strategy, or other significant
  implementation choices). Backed by the local `ctx` CLI.
---

# context

Use this skill BEFORE any consequential engineering decision, including:

- architecture and service boundaries
- adding or choosing dependencies
- data modeling and schema design
- infrastructure and deployment choices
- security-sensitive changes
- testing strategy
- other significant implementation choices

## Automatic retrieval (push)

Relevant developer context is often injected for you automatically: a
`ctx` prompt hook runs on each user message and, when it finds relevant
preferences, prepends a `<ctx-developer-context>` block to the conversation.
When you see that block, it is authoritative — apply it. If a repo preference and
a global preference conflict, the repo preference wins.

## Proactive retrieval (pull)

The push path above catches the obvious cases, but it can miss context for terse or
oblique tasks. So when a decision could depend on established context and it was NOT
already injected this turn, retrieve it yourself:

Persistent developer and project context — established preferences, conventions, prior technical choices, and known exceptions — is available through ctx, and relevant context is often injected for you automatically. Before a choice that could reasonably depend on how this developer or repository usually works, make sure you have that context: retrieve it when it was not already provided. Oblique requests count: a task phrased as an outcome rather than a named decision often still hides such a choice — translate the goal into the decision axis it implies (testing, dependencies, persistence, architecture, style, runtime, deployment, security, naming, or tooling) and check that too. The test is whether the right implementation could depend on an existing user or project decision, not whether the task is vague. Do not retrieve for requests that clearly do not depend on developer/project context.

When you need it, run `ctx get --cwd "$PWD" --task "<concise task>"`. A terse task description is enough —
ctx augments it with the repository, active files, and language. This is a
read-only lookup; it never writes or changes memory, so it is safe anytime.

Retrieve when the task is something like:
- adding or choosing a dependency, library, or tool
- picking a test framework or writing tests
- setting up persistence, a database, or storage
- choosing a language or runtime for a script
- adding a formatter, linter, or build step
- writing code meant to match this repo's conventions (another endpoint, a new module)
- an architecture choice (caching, queueing, service boundaries)
- how the user wants to be addressed, named, or referred to
- a decision this project already settled (how auth works, how errors are represented, an API shape)
- a known exception or a correction the developer has made before
- an outcome-phrased request that implies an unstated choice ("give this a safety net" → tests, "make it production-ready" → deployment/runtime, "add persistence" → database)

Do NOT retrieve for:
- general factual or conceptual questions ("explain TCP slow start", "what does HTTP 404 mean")
- explaining an error message, a concept, or existing code
- summarizing or reformatting text you were given
- a pure one-off edit that involves no technology or convention choice

Form a good query. Form a semantic query, not a keyword echo of the prompt. Name the underlying decision and its object, and that it concerns this developer's or repository's convention. Lead with the intent category when one fits — dependency, testing, database, architecture, tooling, formatting/style, language/runtime, deployment, security, naming/identity, or a repo convention. For an oblique, outcome-phrased task, name the decision it implies rather than its surface words: "give this a safety net" → "testing framework and conventions for this repository"; "ship this" → "deployment / release convention for this repository". For example: "add uuid" → "dependency / package choice for adding uuid in this repo"; "add tests" → "testing framework and conventions for this repository"; "what do you call me?" → "the user's preferred name / how they want to be addressed". Prefer concrete, content-bearing terms — the action, the artifact, and plausible concrete options — over abstract nouns alone ("how we deploy to production", not just "production readiness"). Keep it to one concise phrase; ctx augments it with the repository, active files, and language on its own.

Explicit commands. When the user issues an explicit retrieval command — for example "ctx it", "check ctx", "check goatedcontext", "look in ctx", "look that up in ctx", or "check memory" — treat it as a direct instruction to retrieve BEFORE answering, even if you would not have retrieved on your own. The command is NOT the query: do not search for the words "ctx it". Build the query from the user's immediately preceding unresolved request — the last real question or task — then answer THAT request using what you retrieve. For example, after "What do you call me?" the follow-up "ctx it" means retrieve the user's preferred name / how they want to be addressed, then answer with it. Carry forward only that one immediately-relevant request, never replay the whole conversation.

Avoid redundant lookups: if the relevant context was already injected this turn (a `<ctx-developer-context>` block), use it — do not re-fetch the same thing. And do not query on every turn; use judgment about whether memory could matter.

`ctx get` returns concise JSON (repo, relevance-filtered conflict-resolved
preferences, available environments). Never ask `ctx` for secrets — it does not
return them, by design.
