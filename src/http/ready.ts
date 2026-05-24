// [AUDIT-L10] /ready (readiness) — 200 only when DB and Redis are reachable.
// Used by Docker HEALTHCHECK and any future load balancer.

import type { Hono } from 'hono';
import type { Redis } from 'ioredis';
import type { Logger } from '../types.js';

export interface ReadinessChecks {
  pingDb(): Promise<boolean>;
  redis: Redis;
  logger: Logger;
}

export function registerReady(app: Hono, checks: ReadinessChecks): void {
  app.get('/ready', async (c) => {
    const [dbOk, redisOk] = await Promise.all([
      safe(checks.pingDb(), checks.logger, 'db'),
      safe(redisPing(checks.redis), checks.logger, 'redis'),
    ]);
    const ok = dbOk && redisOk;
    return c.json({ status: ok ? 'ok' : 'degraded', db: dbOk, redis: redisOk }, ok ? 200 : 503);
  });
}

async function safe(p: Promise<boolean>, logger: Logger, what: string): Promise<boolean> {
  try {
    return await p;
  } catch (e) {
    logger.warn({ err: e, dep: what }, 'readiness_probe_failed');
    return false;
  }
}

async function redisPing(redis: Redis): Promise<boolean> {
  const pong = await redis.ping();
  return pong === 'PONG';
}
