import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import type { Status } from "../src/core/preferences/types.ts";

/**
 * Preference state-transition matrix (Wave 3). The key safety property: `approve` must
 * never silently UNLOCK a locked rule (locked is the strongest in-effect state).
 */

function prefWith(status: Status) {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({ rule: "Use PostgreSQL.", category: "database", scope: "global", status });
  return { t, p };
}

test("proposed + approve → approved (records an approve event)", () => {
  const { t } = prefWith("proposed");
  const p = t.ctx.preferences.list({ status: "proposed" })[0]!;
  const after = t.ctx.preferences.approve(p.id);
  expect(after.status).toBe("approved");
  expect(t.ctx.events.list().map((e) => e.type)).toContain("preference.approved");
  t.cleanup();
});

test("locked + approve → locked (no-op, no event, no version bump)", () => {
  const { t, p } = prefWith("locked");
  const after = t.ctx.preferences.approve(p.id);
  expect(after.status).toBe("locked");
  expect(after.version).toBe(p.version);
  expect(t.ctx.events.list().map((e) => e.type)).not.toContain("preference.unlocked");
  expect(t.ctx.events.list().map((e) => e.type)).not.toContain("preference.approved");
  t.cleanup();
});

test("approved + approve → approved (idempotent no-op)", () => {
  const { t, p } = prefWith("approved");
  const before = t.ctx.events.list().length;
  const after = t.ctx.preferences.approve(p.id);
  expect(after.status).toBe("approved");
  expect(after.version).toBe(p.version); // no write
  expect(t.ctx.events.list().length).toBe(before); // no new event
  t.cleanup();
});

test("rejected + approve → approved (re-approval allowed)", () => {
  const { t, p } = prefWith("approved");
  t.ctx.preferences.reject(p.id);
  const rejected = t.ctx.preferences.getById(p.id)!;
  const after = t.ctx.preferences.approve(rejected.id);
  expect(after.status).toBe("approved");
  t.cleanup();
});

test("locked + reject → rejected (explicit command still transitions, recorded)", () => {
  const { t, p } = prefWith("locked");
  const after = t.ctx.preferences.reject(p.id);
  expect(after.status).toBe("rejected");
  expect(t.ctx.events.list().map((e) => e.type)).toContain("preference.rejected");
  t.cleanup();
});

test("approved + lock → locked", () => {
  const { t, p } = prefWith("approved");
  const after = t.ctx.preferences.lock(p.id);
  expect(after.status).toBe("locked");
  t.cleanup();
});
