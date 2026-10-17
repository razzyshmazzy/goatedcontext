/**
 * The ctx OVERSEER — an event-driven memory-activation layer (prototype).
 *
 * It watches a coding agent's workflow as a stream of normalized AgentEvents and
 * surfaces context when a *later* action makes a stored memory relevant — even when
 * the original prompt did not. It is a COMPLEMENT to prompt-time retrieval, never a
 * replacement. Deterministic-first: no embeddings, no runtime LLM, no daemon.
 */
export * from "./vocab.ts";
export * from "./event.ts";
export * from "./features.ts";
export * from "./activation.ts";
export * from "./candidate-index.ts";
export * from "./workflow-state.ts";
export * from "./ledger.ts";
export * from "./temporal.ts";
export * from "./overseer.ts";
