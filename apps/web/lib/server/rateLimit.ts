/**
 * A token bucket per key, in memory (spec §14.4: chat and top-up endpoints are
 * rate-limited per address and per IP). Per server instance, which bounds abuse
 * without a shared store; a fleet-wide limit is an operations concern layered on
 * top (the platform firewall), not a reason to let one instance be hammered.
 */
export interface RateLimiter {
  take(key: string, now?: number): { ok: true } | { ok: false; retryAfterSeconds: number };
  size(): number;
}

export function createRateLimiter(options: { limit: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  const refillMs = windowMs / limit;
  const buckets = new Map<string, { tokens: number; at: number }>();

  return {
    take(key, now = Date.now()) {
      const bucket = buckets.get(key) ?? { tokens: limit, at: now };
      const tokens = Math.min(limit, bucket.tokens + (now - bucket.at) / refillMs);
      // Re-insert so the Map's order is least-recently-used first.
      buckets.delete(key);
      if (tokens < 1) {
        buckets.set(key, { tokens, at: now });
        return { ok: false, retryAfterSeconds: Math.ceil(((1 - tokens) * refillMs) / 1000) };
      }
      buckets.set(key, { tokens: tokens - 1, at: now });
      while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string);
      return { ok: true };
    },
    size: () => buckets.size,
  };
}
