/**
 * In-memory sliding-window limits for guessing-prone actions (sign-in, PIN, enrollment, unknown
 * device keys). They complement the account lockout and the PIN block, which live in the database.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Seconds until another attempt is allowed (0 = allowed now). Does not count an attempt. */
  retryAfter(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 1000));
  }

  /** Counts one attempt. */
  hit(key: string, now = Date.now()): void {
    if (this.hits.size > 10_000) this.prune(now);
    this.hits.set(key, [...this.recent(key, now), now]);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }
}

export interface RateLimits {
  /** Requests with an unknown device key, per IP address. */
  readonly unknownDevice: RateLimiter;
  /** Sign-in attempts (password or PIN), per device. */
  readonly signIn: RateLimiter;
  /** Enrollment attempts, per IP address. */
  readonly enrollment: RateLimiter;
}

export function defaultRateLimits(): RateLimits {
  return {
    unknownDevice: new RateLimiter(20, 60_000),
    signIn: new RateLimiter(20, 60_000),
    enrollment: new RateLimiter(10, 60_000),
  };
}
