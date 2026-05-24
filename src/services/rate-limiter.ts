// [AUDIT-H4] RateLimiter. Per-user, per-kind, day-bucketed.
//
// Key: `rl:${kind}:${userId}:${YYYY-MM-DD}`
// Strategy: atomic INCR + EXPIRE via pipeline. The counter is incremented
// even for rejected requests — this is intentional, so /spam-style abuse
// can't repeatedly probe the limit without paying for it.

import type { Redis } from 'ioredis';
import type { Logger, UserId } from '../types.js';

export type RateLimitKind = 'text' | 'voice' | 'document';

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  resetsInSec: number;
}

export interface RateLimiter {
  checkAndIncrement(userId: UserId, kind: RateLimitKind): Promise<RateLimitResult>;
}

export interface RateLimiterDeps {
  redis: Redis;
  limits: Record<RateLimitKind, number>;
  logger: Logger;
}

const DAY_SECONDS = 86_400;

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  return {
    async checkAndIncrement(userId, kind) {
      const today = new Date().toISOString().slice(0, 10);
      const key = `rl:${kind}:${userId}:${today}`;
      const limit = deps.limits[kind];

      // Atomic pipeline: INCR then EXPIRE.
      const pipelineResults = await deps.redis.multi().incr(key).expire(key, DAY_SECONDS).exec();
      if (!pipelineResults) {
        // Pipeline returned null — Redis is in trouble. Fail OPEN (allow)
        // so users aren't locked out by infrastructure issues, but log loudly.
        deps.logger.error({ key }, 'rate_limit_pipeline_null');
        return { allowed: true, current: 0, limit, resetsInSec: DAY_SECONDS };
      }

      const incrResult = pipelineResults[0];
      const incrErr = incrResult?.[0];
      const incrVal = incrResult?.[1];
      if (incrErr || typeof incrVal !== 'number') {
        deps.logger.error({ key, err: incrErr }, 'rate_limit_incr_failed');
        return { allowed: true, current: 0, limit, resetsInSec: DAY_SECONDS };
      }

      const current = incrVal;

      if (current > limit) {
        const ttl = await deps.redis.ttl(key);
        return {
          allowed: false,
          current,
          limit,
          // ttl can be -1 (no expiry) / -2 (no key) — clamp.
          resetsInSec: ttl > 0 ? ttl : DAY_SECONDS,
        };
      }

      return { allowed: true, current, limit, resetsInSec: DAY_SECONDS };
    },
  };
}
