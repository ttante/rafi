/** One monotonic budget shared by nested phases; expiry never proves cancellation. */
export class OperationDeadline {
  private expires: number;
  private readonly hardExpires: number;
  constructor(readonly label: string, readonly timeoutMs: number, readonly hardTimeoutMs = timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} deadline must be positive`);
    if (!Number.isFinite(hardTimeoutMs) || hardTimeoutMs < timeoutMs) throw new Error(`${label} hard deadline must cover its normal deadline`);
    const started = performance.now();
    this.expires = started + timeoutMs;
    this.hardExpires = started + hardTimeoutMs;
  }
  /** Only the owning operation may call this after correlated progress. */
  extendForCorrelatedProgress(): void { this.expires = this.hardExpires; }
  remaining(): number { return Math.max(0, this.expires - performance.now()); }
  async run<T>(operation: () => Promise<T>, onTimeout?: () => void): Promise<T> {
    const failure = () => new Error(`${this.label} deadline exceeded after ${this.expires === this.hardExpires ? this.hardTimeoutMs : this.timeoutMs} ms; completion is unknown`);
    const expire = (): Error => {
      try { onTimeout?.(); } catch { /* Cleanup failure cannot establish completion or escape the deadline. */ }
      return failure();
    };
    // An exhausted enclosing budget must never start the next phase.
    if (this.remaining() <= 0) throw expire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          const scheduledExpiry = this.expires;
          const checkExpiry = () => {
            if (this.expires > scheduledExpiry) {
              timer = setTimeout(fail, this.remaining());
            } else fail();
          };
          const fail = () => {
            reject(expire());
          };
          timer = setTimeout(checkExpiry, this.remaining());
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
