// users repository — DB layer.
//
// Business logic (cascade delete, anonymization) lives in services/users.ts.
// incrementFlagCount stays HERE because it's a single atomic SQL operation
// and benefits from being expressed close to the table — see AUDIT-N1, N5.

import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type NewUser, type User, users } from '../schema.js';

export interface FlagCountResult {
  /** Counter after this increment, with weekly lazy-reset already applied. */
  flagCountWeek: number;
  flagCountTotal: number;
  /** True iff this increment crossed the weekly threshold and we set a 24h ban. */
  bannedThisCall: boolean;
  /** True iff this increment crossed the all-time threshold and we set permaban. */
  permabannedThisCall: boolean;
}

export interface UsersRepository {
  findByTgId(tgId: number): Promise<User | undefined>;
  findById(id: number): Promise<User | undefined>;
  create(row: NewUser): Promise<User>;
  update(id: number, patch: Partial<User>): Promise<void>;

  /**
   * [AUDIT-N1, N5] Single-transaction: lazy-reset the weekly counter if
   * the 7-day window has rolled over, increment, then check thresholds and
   * set bannedUntil / bannedPermanent in the SAME transaction. Returns the
   * counters and whether either ban fired this call.
   */
  incrementFlagCount(
    id: number,
    opts: { banThreshold: number; permabanThreshold: number; banReason: string },
  ): Promise<FlagCountResult>;
}

export function createUsersRepository(db: Database): UsersRepository {
  return {
    async findByTgId(tgId) {
      const rows = await db.select().from(users).where(eq(users.tgId, tgId)).limit(1);
      return rows[0];
    },
    async findById(id) {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0];
    },
    async create(row) {
      const [created] = await db.insert(users).values(row).returning();
      if (!created) throw new Error('users.create returned no row');
      return created;
    },
    async update(id, patch) {
      await db
        .update(users)
        .set({ ...patch, updatedAt: sql`NOW()` })
        .where(eq(users.id, id));
    },

    async incrementFlagCount(id, opts) {
      return db.transaction(async (tx) => {
        // Lazy weekly reset + increment in one UPDATE. RETURNING gives us
        // the post-update counters so we can decide on bans below without
        // a separate read.
        const updated = await tx.execute(sql`
          UPDATE users SET
            flag_count_week = CASE
              WHEN flag_count_week_reset_at < NOW() - INTERVAL '7 days' THEN 1
              ELSE flag_count_week + 1
            END,
            flag_count_week_reset_at = CASE
              WHEN flag_count_week_reset_at < NOW() - INTERVAL '7 days' THEN NOW()
              ELSE flag_count_week_reset_at
            END,
            flag_count_total = flag_count_total + 1,
            updated_at = NOW()
          WHERE id = ${id}
          RETURNING flag_count_week, flag_count_total
        `);
        const row = (
          updated as unknown as Array<{
            flag_count_week: number;
            flag_count_total: number;
          }>
        )[0];
        if (!row) throw new Error(`incrementFlagCount: user ${id} not found`);

        const flagCountWeek = Number(row.flag_count_week);
        const flagCountTotal = Number(row.flag_count_total);
        let bannedThisCall = false;
        let permabannedThisCall = false;

        if (flagCountTotal >= opts.permabanThreshold) {
          await tx
            .update(users)
            .set({
              bannedPermanent: true,
              banReason: opts.banReason,
              updatedAt: sql`NOW()`,
            })
            .where(eq(users.id, id));
          permabannedThisCall = true;
        } else if (flagCountWeek >= opts.banThreshold) {
          await tx
            .update(users)
            .set({
              bannedUntil: sql`NOW() + INTERVAL '24 hours'`,
              banReason: opts.banReason,
              updatedAt: sql`NOW()`,
            })
            .where(eq(users.id, id));
          bannedThisCall = true;
        }

        return { flagCountWeek, flagCountTotal, bannedThisCall, permabannedThisCall };
      });
    },
  };
}
