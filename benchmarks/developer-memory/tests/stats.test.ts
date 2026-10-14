import { describe, test, expect } from "bun:test";
import { wilson, proportion, describe as dist, deltaPP, pctWithN } from "../src/stats.ts";

describe("wilson interval", () => {
  test("empty denominator → [NaN, NaN]", () => {
    expect(wilson(0, 0).every(Number.isNaN)).toBe(true);
  });
  test("known value: 50/100 ≈ [0.404, 0.596]", () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
  });
  test("bounds stay within [0,1] at the extremes", () => {
    const [lo, hi] = wilson(100, 100);
    expect(lo).toBeGreaterThan(0.95);
    expect(hi).toBe(1);
    expect(wilson(0, 10)[0]).toBe(0);
  });
});

describe("proportion + formatting", () => {
  test("rate and n display", () => {
    const p = proportion(96, 100);
    expect(p.rate).toBeCloseTo(0.96, 5);
    expect(pctWithN(p)).toBe("96% (96/100)");
  });
  test("deltaPP", () => {
    expect(deltaPP(proportion(96, 100), proportion(41, 100))).toBeCloseTo(55, 5);
  });
});

describe("describe (distribution)", () => {
  test("median + p95", () => {
    const d = dist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d.min).toBe(1);
    expect(d.max).toBe(10);
    expect(d.median).toBe(5);
    expect(d.mean).toBeCloseTo(5.5, 5);
    expect(d.p95).toBe(10);
  });
  test("empty → NaN fields", () => {
    expect(Number.isNaN(dist([]).median)).toBe(true);
  });
});
