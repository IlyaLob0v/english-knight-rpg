/**
 * Counts failures per key in a sliding window: past `max` failures the key waits until the oldest
 * one leaves the window. Kept in memory: one gateway instance serves the school, and a restart
 * forgetting the counts costs an attacker nothing they could not get by waiting.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Seconds until the key may try again; 0 when it may try now. */
  retryAfter(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.max]! + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    this.failures.set(key, [...this.recent(key), this.now()]);
    // Many one-off keys (addresses) must not pile up.
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()]) this.recent(k);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
