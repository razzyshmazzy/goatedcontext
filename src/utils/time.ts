/** Current timestamp in ISO-8601 UTC. All persisted timestamps use this format. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Render an ISO timestamp as a compact, human "… ago" phrase (e.g. "2 minutes
 * ago", "just now"). Used only for human-facing output; machine output keeps the
 * raw ISO string. Returns "(never)" for a null/blank input, and gracefully falls
 * back to the raw string if it cannot be parsed.
 */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "(never)";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  let secs = Math.round((now.getTime() - then) / 1000);
  if (secs < 0) secs = 0; // clock skew — never say "in the future"
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs} seconds ago`;

  // Largest unit whose size fits into the elapsed seconds.
  const ladder: [string, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of ladder) {
    if (secs >= size) {
      const amount = Math.floor(secs / size);
      return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
