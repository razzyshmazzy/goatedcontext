import { randomUUID } from "node:crypto";

/** Generate a stable, unique identifier for a stored record. */
export function newId(): string {
  return randomUUID();
}

/**
 * Match a user-supplied id fragment against a full id.
 * Allows commands like `ctx prefs approve 3f2a` to work without pasting a full UUID.
 */
export function idMatches(fullId: string, fragment: string): boolean {
  if (!fragment) return false;
  const a = fullId.toLowerCase();
  const b = fragment.toLowerCase();
  return a === b || a.startsWith(b);
}

/** Shorten an id for display in tables. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
