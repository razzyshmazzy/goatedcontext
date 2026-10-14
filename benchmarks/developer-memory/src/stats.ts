/**
 * Aggregate statistics for the benchmark (spec §22–24).
 *
 * Binary pass/fail metrics get a Wilson score interval — the correct interval for a
 * binomial proportion at small n, where the naive normal approximation badly
 * misbehaves near 0% and 100% (exactly the regime a strong memory system lives in).
 * One run is never treated as deterministic truth (spec §24).
 */

export interface Proportion {
  numerator: number;
  denominator: number;
  /** numerator / denominator, or NaN when denominator === 0. */
  rate: number;
  /** Wilson 95% lower/upper bounds; [NaN, NaN] when denominator === 0. */
  ci95: [number, number];
}

/** z for a two-sided 95% interval. */
const Z_95 = 1.959963984540054;

export function wilson(numerator: number, denominator: number, z: number = Z_95): [number, number] {
  if (denominator === 0) return [NaN, NaN];
  const n = denominator;
  const phat = numerator / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const lower = (center - margin) / denom;
  const upper = (center + margin) / denom;
  return [Math.max(0, lower), Math.min(1, upper)];
}

export function proportion(numerator: number, denominator: number): Proportion {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? NaN : numerator / denominator,
    ci95: wilson(numerator, denominator),
  };
}

/** Percent string with fixed precision, or "n/a" for an empty denominator. */
export function pct(p: Proportion, digits = 0): string {
  if (Number.isNaN(p.rate)) return "n/a";
  return `${(p.rate * 100).toFixed(digits)}%`;
}

/** "96% (96/100)" — the honest display the spec mandates (§23). */
export function pctWithN(p: Proportion, digits = 0): string {
  if (Number.isNaN(p.rate)) return "n/a (0/0)";
  return `${pct(p, digits)} (${p.numerator}/${p.denominator})`;
}

/** Numeric distribution summary for continuous metrics (context cost, latency). */
export interface Dist {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
}

export function describe(values: number[]): Dist {
  const n = values.length;
  if (n === 0) return { n: 0, min: NaN, max: NaN, mean: NaN, median: NaN, p95: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx]!;
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / n,
    median: quantile(0.5),
    p95: quantile(0.95),
  };
}

/** Absolute percentage-point delta between two proportions (ctx − control), for headlines (§23). */
export function deltaPP(ctx: Proportion, control: Proportion): number {
  if (Number.isNaN(ctx.rate) || Number.isNaN(control.rate)) return NaN;
  return (ctx.rate - control.rate) * 100;
}
