// usage_stats_daily repository — per-(day, user) counters used by
// CostTracker for the spreadsheet view, and by /stats for the 24h snapshot.

import { and, gte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { usageStatsDaily } from '../schema.js';

export type RequestKind = 'text' | 'voice' | 'document';

export interface UpsertDailyOpts {
  date: string; // YYYY-MM-DD
  userId: number;
  kind: RequestKind;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
}

export interface DailyTotals {
  dau: number;
  textMessages: number;
  voiceMessages: number;
  documents: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
}

export interface UsageStatsRepository {
  upsertDaily(opts: UpsertDailyOpts): Promise<void>;
  /** Aggregated totals starting from a given UTC date (inclusive). */
  totalsSince(date: string): Promise<DailyTotals>;
}

export function createUsageStatsRepository(db: Database): UsageStatsRepository {
  return {
    async upsertDaily(opts) {
      const kindFieldMap = {
        text: usageStatsDaily.textMessages,
        voice: usageStatsDaily.voiceMessages,
        document: usageStatsDaily.documents,
      } as const;
      const kindCol = kindFieldMap[opts.kind];

      await db
        .insert(usageStatsDaily)
        .values({
          date: opts.date,
          userId: opts.userId,
          textMessages: opts.kind === 'text' ? 1 : 0,
          voiceMessages: opts.kind === 'voice' ? 1 : 0,
          documents: opts.kind === 'document' ? 1 : 0,
          tokensInput: opts.tokensInput,
          tokensOutput: opts.tokensOutput,
          costUsd: opts.costUsd.toString(),
        })
        .onConflictDoUpdate({
          target: [usageStatsDaily.date, usageStatsDaily.userId],
          set: {
            [opts.kind === 'text'
              ? 'textMessages'
              : opts.kind === 'voice'
                ? 'voiceMessages'
                : 'documents']: sql`${kindCol} + 1`,
            tokensInput: sql`${usageStatsDaily.tokensInput} + ${opts.tokensInput}`,
            tokensOutput: sql`${usageStatsDaily.tokensOutput} + ${opts.tokensOutput}`,
            costUsd: sql`${usageStatsDaily.costUsd} + ${opts.costUsd}`,
          },
        });
    },

    async totalsSince(date) {
      const [row] = await db
        .select({
          dau: sql<number>`COUNT(DISTINCT ${usageStatsDaily.userId})`.as('dau'),
          textMessages: sql<number>`COALESCE(SUM(${usageStatsDaily.textMessages}), 0)`.as(
            'text_messages',
          ),
          voiceMessages: sql<number>`COALESCE(SUM(${usageStatsDaily.voiceMessages}), 0)`.as(
            'voice_messages',
          ),
          documents: sql<number>`COALESCE(SUM(${usageStatsDaily.documents}), 0)`.as('documents'),
          tokensInput: sql<number>`COALESCE(SUM(${usageStatsDaily.tokensInput}), 0)`.as(
            'tokens_input',
          ),
          tokensOutput: sql<number>`COALESCE(SUM(${usageStatsDaily.tokensOutput}), 0)`.as(
            'tokens_output',
          ),
          costUsd: sql<number>`COALESCE(SUM(${usageStatsDaily.costUsd}::numeric), 0)`.as(
            'cost_usd',
          ),
        })
        .from(usageStatsDaily)
        .where(and(gte(usageStatsDaily.date, date)));
      return {
        dau: Number(row?.dau ?? 0),
        textMessages: Number(row?.textMessages ?? 0),
        voiceMessages: Number(row?.voiceMessages ?? 0),
        documents: Number(row?.documents ?? 0),
        tokensInput: Number(row?.tokensInput ?? 0),
        tokensOutput: Number(row?.tokensOutput ?? 0),
        costUsd: Number(row?.costUsd ?? 0),
      };
    },
  };
}
