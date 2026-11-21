/**
 * Wall-clock assertions in tests. A noisy machine (a loaded laptop, a CI runner) fails absolute millisecond bounds for
 * reasons that have nothing to do with the code, so the tests assert work-proportional facts that hold on any machine
 * (one thing is several times cheaper than another, measured in the same run), and keep the absolute budgets behind
 * `DATUM_BENCH=1`, for a quiet machine when someone is tuning performance.
 */
declare const process: { env: Record<string, string | undefined> };

export const BENCH =process.env.DATUM_BENCH === "1";

/** An absolute budget in ms: enforced only under `DATUM_BENCH=1`, unbounded otherwise. */
export const budget = (ms: number): number => (BENCH ? ms : Number.POSITIVE_INFINITY);

/** The fastest of `runs` timings of `fn` in ms (the minimum is the least affected by whatever else the machine is doing). */
export function bestOf(runs: number, fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
