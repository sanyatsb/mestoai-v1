// CostTracker tests — ioredis-mock for the Redis aggregate + a tiny in-memory
// stub for the usage_stats repo + a mock bot.api.sendMessage to verify
// admin alerts fire the right number of times.

import IORedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCostTracker } from '../../../src/services/cost-tracker.js';
import { toUserId } from '../../../src/utils/ids.js';

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

async function makeDeps(
  overrides: Partial<Parameters<typeof createCostTracker>[0]['config']> = {},
) {
  // ioredis-mock shares in-memory state across `new IORedisMock()` calls
  // in the same process, so we flushall the freshly-created instance to
  // isolate each test from cost:daily:* counters / cost:alerted:* /
  // kill_switch left by previous tests.
  const redis = new IORedisMock();
  await redis.flushall();
  // ioredis-mock occasionally retains state between instances depending on
  // version; belt-and-braces explicit cleanup of the keys this suite uses.
  await redis.del('kill_switch');
  const today = new Date().toISOString().slice(0, 10);
  await redis.del(`cost:daily:${today}`);
  await redis.del(`cost:alerted:${today}`);
  const upsertDaily = vi.fn().mockResolvedValue(undefined);
  const totalsSince = vi.fn().mockResolvedValue({
    dau: 0,
    textMessages: 0,
    voiceMessages: 0,
    documents: 0,
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
  });
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const config = {
    dailyBudgetUsd: 50,
    alertThresholdUsd: 30,
    costPerInputToken: 0.0000003,
    costPerOutputToken: 0.0000012,
    adminChatId: 1,
    ...overrides,
  };
  const deps = {
    // biome-ignore lint/suspicious/noExplicitAny: mock client surface
    redis: redis as any,
    usageStats: { upsertDaily, totalsSince },
    bot: { api: { sendMessage } },
    config,
    logger: silentLogger,
  };
  return { redis, deps, upsertDaily, totalsSince, sendMessage, config };
}

describe('CostTracker.trackRequest', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists a per-(day, user) row and returns the running daily total', async () => {
    const { deps, upsertDaily } = await makeDeps();
    const tracker = createCostTracker(deps);

    const r = await tracker.trackRequest({
      userId: toUserId(42),
      kind: 'text',
      tokensInput: 100,
      tokensOutput: 50,
    });

    expect(upsertDaily).toHaveBeenCalledOnce();
    const arg = upsertDaily.mock.calls[0]?.[0];
    expect(arg.userId).toBe(42);
    expect(arg.kind).toBe('text');
    expect(arg.tokensInput).toBe(100);
    // Cost = 100 * 0.0000003 + 50 * 0.0000012 = 0.00003 + 0.00006 = 0.00009
    expect(arg.costUsd).toBeCloseTo(0.00009, 8);
    expect(r.dailyTotalUsd).toBeCloseTo(0.00009, 8);
    expect(r.overAlertThreshold).toBe(false);
    expect(r.overKillThreshold).toBe(false);
  });

  it('[AUDIT-H5] alerts admin exactly once per day at the soft threshold', async () => {
    // Threshold $5; each call below spends $6 worth (5M output tokens at
    // $0.0000012/tok). First crosses the threshold, the other two MUST NOT
    // re-alert because of the SET NX EX dedup lock.
    const { deps, sendMessage } = await makeDeps({ alertThresholdUsd: 5, dailyBudgetUsd: 9999 });
    const tracker = createCostTracker(deps);

    for (let i = 0; i < 3; i++) {
      await tracker.trackRequest({
        userId: toUserId(1),
        kind: 'text',
        tokensInput: 0,
        tokensOutput: 5_000_000, // 5M * 0.0000012 = 6.0
      });
    }
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[1]).toMatch(/Daily cost crossed/);
  });

  it('[AUDIT-X14] trips the kill switch + alerts when daily budget is exceeded', async () => {
    const { deps, redis, sendMessage } = await makeDeps({
      alertThresholdUsd: 5,
      dailyBudgetUsd: 10,
    });
    const tracker = createCostTracker(deps);

    // 5M output tokens = $6 — crosses alert ($5) but stays under kill ($10).
    await tracker.trackRequest({
      userId: toUserId(1),
      kind: 'text',
      tokensInput: 0,
      tokensOutput: 5_000_000,
    });
    expect(await redis.get('kill_switch')).toBeNull();
    // Second call doubles us to $12 — over kill threshold.
    await tracker.trackRequest({
      userId: toUserId(1),
      kind: 'text',
      tokensInput: 0,
      tokensOutput: 5_000_000,
    });

    expect(await redis.get('kill_switch')).toBe('1');
    // Two notifications now: 1 soft + 1 kill.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[1]).toMatch(/KILL SWITCH/);
  });

  it('isKillSwitchActive reads from Redis', async () => {
    const { deps, redis } = await makeDeps();
    const tracker = createCostTracker(deps);
    expect(await tracker.isKillSwitchActive()).toBe(false);
    await redis.set('kill_switch', '1');
    expect(await tracker.isKillSwitchActive()).toBe(true);
  });

  it('survives a usage-stats DB failure and still updates the Redis aggregate', async () => {
    // The upsertDaily mock throws — Redis aggregate must still update so
    // admin alerts and kill-switch logic remain accurate.
    const { deps, upsertDaily, redis } = await makeDeps();
    upsertDaily.mockRejectedValueOnce(new Error('db blip'));
    const tracker = createCostTracker(deps);

    const r = await tracker.trackRequest({
      userId: toUserId(1),
      kind: 'text',
      tokensInput: 100,
      tokensOutput: 50,
    });
    expect(r.dailyTotalUsd).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(await redis.get(`cost:daily:${today}`)).toMatch(/^0\./);
  });

  it('different kinds increment the right counter', async () => {
    const { deps, upsertDaily } = await makeDeps();
    const tracker = createCostTracker(deps);
    await tracker.trackRequest({
      userId: toUserId(1),
      kind: 'voice',
      tokensInput: 0,
      tokensOutput: 0,
    });
    await tracker.trackRequest({
      userId: toUserId(1),
      kind: 'document',
      tokensInput: 0,
      tokensOutput: 0,
    });
    expect(upsertDaily.mock.calls.map((c) => c[0].kind)).toEqual(['voice', 'document']);
  });
});
