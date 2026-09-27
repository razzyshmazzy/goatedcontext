/** Current timestamp in ISO-8601 UTC. All persisted timestamps use this format. */
export function nowIso(): string {
  return new Date().toISOString();
}
