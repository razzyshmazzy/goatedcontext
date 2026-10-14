# External-benchmark feasibility (spec §40, §41)

Both are **secondary** and would be reported separately from the first-party developer-memory
headline numbers. Neither is implemented in this pass; this documents whether/how they fit.

## LongMemEval (§40)

**What it is.** A large benchmark of long-term *conversational* memory for chat assistants —
information extraction, multi-session reasoning, temporal reasoning, knowledge updates,
abstention, over ~500 curated questions with long distractor histories.

**Fit with ctx.** Partial and narrow. ctx is **developer** memory (durable engineering
preferences/decisions, provenance-gated, behaviorally applied), not general autobiographical
chat memory. Two LongMemEval abilities map cleanly onto ctx semantics:
- **knowledge-update** ↔ ctx corrections/reversals (our §9 category);
- **abstention** ↔ ctx must-not-fire (our §16 category).
Information-extraction and personal-life temporal questions do **not** map — turning
"my sister's birthday is in May" into a "developer preference" would be dishonest (§40).

**Verdict.** Feasible as an adapter over the *knowledge-update* and *abstention* subsets only,
using `ctx agent remember` as the backend and `ctx agent context` for retrieval, scored by
LongMemEval's own QA metric. Report strictly as *"external general-memory benchmark, update+abstention
subset"* — never as the ctx headline. Licensing/data: public dataset on HuggingFace/GitHub;
setup is practical. **Not implemented here** (headline-first; §56).

## LoCoMo / implicit conversational memory (§41)

**What it is.** Very long multi-session dialogues with QA + event-graph + summarization tasks;
methodologically interesting for ctx because many probes require memory **implicitly**.

**Fit with ctx.** The *methodology* (implicit later use of an earlier-stated fact) is exactly our
implicit category (§10) — but LoCoMo items are autobiographical, not developer decisions.
Forcing them into "preferences" would misrepresent both ctx and LoCoMo.

**Two honest options:**
- **A** — run only the clearly preference/decision-style items as-is;
- **B** — *adapt the methodology* to developer scenarios (which is precisely what this suite's
  depth-sweep + implicit-probe design already does).

**Verdict.** We adopt **B** (methodology, not data) in the first-party suite and label it as such;
we do **not** present adapted results as official LoCoMo numbers. A small option-A adapter over
decision-style items is feasible later but low priority.

## Needle methodology (§42)
Used as *methodology only*: our "needle" is a developer preference, our "haystack" is realistic
coding work, our probe is a later decision that implicitly depends on it. This is **not** called
Needle-in-a-Haystack and does not ask the agent to quote a hidden sentence.
