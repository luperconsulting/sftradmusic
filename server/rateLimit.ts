import { ApiError } from "./http.js";

export interface RateLimiter {
  /** Throws 429 once `key` has been used more than `limit` times in `windowMs`. */
  hit(key: string, limit: number, windowMs: number): void;
}

// Per-instance memory: this slows abuse, but serverless instances don't share it. See the handoff doc for
// moving to a shared store before relying on it as the only control.
export function memoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, limit, windowMs) {
      const t = now();
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= t) {
        hits.set(key, { count: 1, resetAt: t + windowMs });
        if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
        return;
      }
      cur.count += 1;
      if (cur.count > limit) throw new ApiError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    },
  };
}
