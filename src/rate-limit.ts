import { KV_ATOMIC_MAX_RETRIES, KV_PREFIX } from "./constants.ts";
import { state } from "./state.ts";

const RATE_LIMIT_PREFIX = [KV_PREFIX, "rate-limit"] as const;

export interface RateLimitRule {
  namespace: string;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export async function checkKvRateLimit(
  rule: RateLimitRule,
  key: string,
): Promise<RateLimitResult> {
  const kvKey = [...RATE_LIMIT_PREFIX, rule.namespace, key];

  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const now = Date.now();
    const entry = await state.kv.get<RateLimitBucket>(kvKey);
    const current = entry.value;

    if (current === null || now >= current.resetAt) {
      const next = { count: 1, resetAt: now + rule.windowMs };
      const result = await state.kv.atomic()
        .check(entry)
        .set(kvKey, next, { expireIn: rule.windowMs })
        .commit();
      if (result.ok) return { allowed: true, retryAfterMs: 0 };
      continue;
    }

    const retryAfterMs = current.resetAt - now;
    if (current.count >= rule.maxRequests) {
      return { allowed: false, retryAfterMs };
    }

    const next = { count: current.count + 1, resetAt: current.resetAt };
    const result = await state.kv.atomic()
      .check(entry)
      .set(kvKey, next, { expireIn: retryAfterMs })
      .commit();
    if (result.ok) return { allowed: true, retryAfterMs: 0 };
  }

  throw new Error("KV rate limit update failed after retries");
}

export async function resetKvRateLimitsForTests(): Promise<void> {
  const iter = state.kv.list({ prefix: RATE_LIMIT_PREFIX });
  const deletes: Promise<void>[] = [];
  for await (const entry of iter) {
    deletes.push(state.kv.delete(entry.key));
  }
  await Promise.all(deletes);
}
