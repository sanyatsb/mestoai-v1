import IORedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../../../src/services/rate-limiter.js';
import type { UserId } from '../../../src/types.js';

const silentLogger = {
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino-like stub
} as any;

describe('RateLimiter (ioredis-mock)', () => {
  let redis: InstanceType<typeof IORedisMock>;
  beforeEach(() => {
    redis = new IORedisMock();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00Z'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await redis.quit();
  });

  it('allows up to limit then blocks', async () => {
    const rl = createRateLimiter({
      // biome-ignore lint/suspicious/noExplicitAny: mock client
      redis: redis as any,
      limits: { text: 3, voice: 1, document: 1 },
      logger: silentLogger,
    });
    const uid = 7 as UserId;
    for (let i = 1; i <= 3; i++) {
      const r = await rl.checkAndIncrement(uid, 'text');
      expect(r.allowed).toBe(true);
      expect(r.current).toBe(i);
      expect(r.limit).toBe(3);
    }
    const blocked = await rl.checkAndIncrement(uid, 'text');
    expect(blocked.allowed).toBe(false);
    expect(blocked.current).toBe(4);
  });

  it('different kinds have independent buckets', async () => {
    const rl = createRateLimiter({
      // biome-ignore lint/suspicious/noExplicitAny: mock client
      redis: redis as any,
      limits: { text: 1, voice: 1, document: 1 },
      logger: silentLogger,
    });
    const uid = 11 as UserId;
    expect((await rl.checkAndIncrement(uid, 'text')).allowed).toBe(true);
    // text is now exhausted, voice should still be ok
    expect((await rl.checkAndIncrement(uid, 'voice')).allowed).toBe(true);
  });

  it('different users have independent buckets', async () => {
    const rl = createRateLimiter({
      // biome-ignore lint/suspicious/noExplicitAny: mock client
      redis: redis as any,
      limits: { text: 1, voice: 1, document: 1 },
      logger: silentLogger,
    });
    expect((await rl.checkAndIncrement(1 as UserId, 'text')).allowed).toBe(true);
    expect((await rl.checkAndIncrement(2 as UserId, 'text')).allowed).toBe(true);
    expect((await rl.checkAndIncrement(1 as UserId, 'text')).allowed).toBe(false);
  });

  it('counter increments even when rejected (anti-spam)', async () => {
    // [AUDIT-H4] documented behavior
    const rl = createRateLimiter({
      // biome-ignore lint/suspicious/noExplicitAny: mock client
      redis: redis as any,
      limits: { text: 1, voice: 1, document: 1 },
      logger: silentLogger,
    });
    const uid = 13 as UserId;
    await rl.checkAndIncrement(uid, 'text');
    const r1 = await rl.checkAndIncrement(uid, 'text');
    const r2 = await rl.checkAndIncrement(uid, 'text');
    expect(r1.current).toBe(2);
    expect(r2.current).toBe(3);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
  });
});
