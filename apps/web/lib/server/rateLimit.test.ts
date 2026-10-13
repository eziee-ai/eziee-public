import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rateLimit";

describe("createRateLimiter", () => {
  it("allows a burst up to the limit, then refuses and says when to retry", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect([1, 2, 3].map(() => limiter.take("a", 0).ok)).toEqual([true, true, true]);
    expect(limiter.take("a", 1_000)).toEqual({ ok: false, retryAfterSeconds: 19 });
  });

  it("refills steadily, one slot per window/limit", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) limiter.take("a", 0);
    expect(limiter.take("a", 19_999).ok).toBe(false);
    expect(limiter.take("a", 20_000).ok).toBe(true);
  });

  it("keeps keys apart", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("b", 0).ok).toBe(true);
  });

  it("forgets idle keys, so memory cannot grow without bound", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2 });
    limiter.take("a", 0);
    limiter.take("b", 0);
    limiter.take("c", 5_000);
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });
});
