// Provider and timeout retries back off 10 s, 30 s, 90 s, each ±20% (ARCH 5.1); jitter in [-1, 1] from deps.random.
const STEPS: readonly number[] = Object.freeze([10_000, 30_000, 90_000]);

export function backoffMs(retry: number, jitter: number): number {
  const base = STEPS[Math.min(retry, STEPS.length) - 1] ?? STEPS[STEPS.length - 1]!;
  return Math.round(base * (1 + 0.2 * Math.max(-1, Math.min(1, jitter))));
}
