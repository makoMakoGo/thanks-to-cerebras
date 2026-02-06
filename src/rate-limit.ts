interface BucketEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, BucketEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const entry = this.buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (entry.count < this.maxRequests) {
      entry.count++;
      return { allowed: true, retryAfterMs: 0 };
    }

    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.buckets) {
      if (now >= entry.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}

export const loginLimiter = new RateLimiter(5, 60_000);
