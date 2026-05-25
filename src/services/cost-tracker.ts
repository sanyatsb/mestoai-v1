// [AUDIT-X14, X15, H5, B1] CostTracker.
//
// trackRequest is called from chat/voice/document composers after every
// successful Gonka call. It does three things:
//   1. Update the per-(day, user) row in usage_stats_daily (kind-dispatched
//      counter + token totals + cost).
//   2. Increment a Redis daily-aggregate (cost:daily:YYYY-MM-DD) so admin
//      alerts fire in O(1) without scanning the table.
//   3. If the aggregate crosses thresholds, alert admin once per day
//      (atomic SET NX EX dedup [AUDIT-H5]) and trip the kill switch
//      automatically if we blow past the daily budget.
//
// [AUDIT-B1] resetDailyFlags() is intentionally GONE — Redis TTL handles
// the dedup window. node-cron only needs the audit-log cleanup.

import type { Redis } from 'ioredis';
import type { RequestKind, UsageStatsRepository } from '../db/repositories/usage-stats.js';
import type { Logger, UserId } from '../types.js';
import type { BotApiHandle } from './moderation.js';

export type { RequestKind };

export interface CostTrackingResult {
  dailyTotalUsd: number;
  overAlertThreshold: boolean;
  overKillThreshold: boolean;
}

export interface CostTracker {
  trackRequest(opts: {
    userId: UserId;
    kind: RequestKind;
    tokensInput: number;
    tokensOutput: number;
  }): Promise<CostTrackingResult>;
  isKillSwitchActive(): Promise<boolean>;
  /** 24h snapshot used by /stats. */
  totalsToday(): Promise<{
    dau: number;
    textMessages: number;
    voiceMessages: number;
    documents: number;
    costUsd: number;
  }>;
}

export interface CostTrackerConfig {
  dailyBudgetUsd: number;
  alertThresholdUsd: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  adminChatId: number;
}

export interface CostTrackerDeps {
  usageStats: UsageStatsRepository;
  redis: Redis;
  bot: BotApiHandle;
  config: CostTrackerConfig;
  logger: Logger;
}

const KILL_SWITCH_KEY = 'kill_switch';

export function createCostTracker(deps: CostTrackerDeps): CostTracker {
  return {
    async trackRequest(opts) {
      const cost =
        opts.tokensInput * deps.config.costPerInputToken +
        opts.tokensOutput * deps.config.costPerOutputToken;
      const today = todayUtc();

      // 1. Persist the per-(day, user) counter.
      try {
        await deps.usageStats.upsertDaily({
          date: today,
          userId: opts.userId as number,
          kind: opts.kind,
          tokensInput: opts.tokensInput,
          tokensOutput: opts.tokensOutput,
          costUsd: cost,
        });
      } catch (e) {
        deps.logger.error({ err: e }, 'usage_stats_upsert_failed');
        // Still try Redis aggregate; one missed row is recoverable.
      }

      // 2. Bump the Redis daily aggregate. Expire slightly past 24h so a
      // request landing right at midnight UTC doesn't lose state.
      const dailyKey = `cost:daily:${today}`;
      let dailyTotal = 0;
      try {
        const total = await deps.redis.incrbyfloat(dailyKey, cost);
        await deps.redis.expire(dailyKey, 86_400 + 3600);
        dailyTotal = Number.parseFloat(total);
      } catch (e) {
        deps.logger.error({ err: e }, 'cost_aggregate_failed');
      }

      const overAlert = dailyTotal > deps.config.alertThresholdUsd;
      const overKill = dailyTotal > deps.config.dailyBudgetUsd;

      // 3a. Alert once per day at the soft threshold. [AUDIT-H5] SET NX EX
      // is atomic — exactly one of the racing callers wins.
      if (overAlert) {
        try {
          const lock = await deps.redis.set(`cost:alerted:${today}`, '1', 'EX', 86_400, 'NX');
          if (lock === 'OK') {
            await notifyAdmin(
              deps,
              `⚠️ Daily cost crossed $${deps.config.alertThresholdUsd}: now $${dailyTotal.toFixed(2)}.`,
            );
          }
        } catch (e) {
          deps.logger.warn({ err: e }, 'cost_alert_dedup_failed');
        }
      }

      // 3b. Hard cap: trip the kill switch and alert immediately. We DON'T
      // dedup this one — admins should hear about every breach.
      if (overKill) {
        try {
          await deps.redis.set(KILL_SWITCH_KEY, '1', 'EX', 86_400);
          await notifyAdmin(
            deps,
            `🚨 KILL SWITCH: daily cost $${dailyTotal.toFixed(2)} exceeded budget $${deps.config.dailyBudgetUsd}.`,
          );
        } catch (e) {
          deps.logger.warn({ err: e }, 'cost_kill_switch_set_failed');
        }
      }

      return {
        dailyTotalUsd: dailyTotal,
        overAlertThreshold: overAlert,
        overKillThreshold: overKill,
      };
    },

    async isKillSwitchActive() {
      try {
        return (await deps.redis.get(KILL_SWITCH_KEY)) === '1';
      } catch (e) {
        deps.logger.warn({ err: e }, 'kill_switch_read_failed');
        return false;
      }
    },

    async totalsToday() {
      const today = todayUtc();
      const r = await deps.usageStats.totalsSince(today);
      return {
        dau: r.dau,
        textMessages: r.textMessages,
        voiceMessages: r.voiceMessages,
        documents: r.documents,
        costUsd: r.costUsd,
      };
    },
  };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function notifyAdmin(deps: CostTrackerDeps, text: string): Promise<void> {
  try {
    await deps.bot.api.sendMessage(deps.config.adminChatId, text);
  } catch (e) {
    deps.logger.warn({ err: e }, 'admin_notify_failed');
  }
}
