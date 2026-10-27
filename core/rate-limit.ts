/** Soft in-memory sliding-window limiter for callback/ingest routes. 0 = off. */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    if (!(this.limit > 0)) return { allowed: true, retryAfterSec: 0 };
    const cutoff = now - this.windowMs;
    const stamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (stamps.length >= this.limit) {
      this.hits.set(key, stamps);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((stamps[0] + this.windowMs - now) / 1000)) };
    }
    stamps.push(now);
    this.hits.set(key, stamps);
    return { allowed: true, retryAfterSec: 0 };
  }
}
