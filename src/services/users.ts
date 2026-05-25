// UsersService — user lifecycle business logic.
//
// [AUDIT-A1, B3] deleteCascade implements GDPR Article 17 (right to erasure)
// for /delete_my_data:
//   - conversations + messages   → hard delete (cascade FK)
//   - usage_stats_daily          → hard delete
//   - user_reports               → hard delete
//   - audit_log                  → ANONYMIZE (security exemption: keep the
//                                  category/score stats so we can still spot
//                                  abuse patterns, but disconnect them from
//                                  any identifiable user)
//   - users                      → hard delete (last)
// All five steps run in a single transaction.

import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { UsersRepository } from '../db/repositories/users.js';
import {
  type NewUser,
  type User,
  auditLog,
  conversations,
  usageStatsDaily,
  userReports,
  users,
} from '../db/schema.js';
import type { Logger } from '../types.js';

export interface UsersService {
  getOrCreate(opts: {
    tgId: number;
    tgUsername?: string;
    firstName?: string;
    languageCode?: string;
  }): Promise<User>;

  update(userId: number, patch: Partial<User>): Promise<void>;

  /** [AUDIT-A1, B3] GDPR delete + audit anonymization. */
  deleteCascade(userId: number): Promise<void>;
}

export interface UsersServiceDeps {
  db: Database;
  users: UsersRepository;
  logger: Logger;
}

export function createUsersService(deps: UsersServiceDeps): UsersService {
  return {
    async getOrCreate(opts) {
      const existing = await deps.users.findByTgId(opts.tgId);
      if (existing) return existing;

      const row: NewUser = {
        tgId: opts.tgId,
        tgUsername: opts.tgUsername ?? null,
        firstName: opts.firstName ?? null,
        languageCode: opts.languageCode ?? 'en',
      };
      const created = await deps.users.create(row);
      deps.logger.info({ tgId: opts.tgId, userId: created.id }, 'user_created');
      return created;
    },

    async update(userId, patch) {
      await deps.users.update(userId, patch);
    },

    async deleteCascade(userId) {
      await deps.db.transaction(async (tx) => {
        // conversations FK has ON DELETE CASCADE for messages, so we don't
        // need to delete messages explicitly — Postgres handles it.
        await tx.delete(conversations).where(eq(conversations.userId, userId));
        await tx.delete(usageStatsDaily).where(eq(usageStatsDaily.userId, userId));
        await tx.delete(userReports).where(eq(userReports.reporterUserId, userId));

        // [AUDIT-B3] anonymize, don't delete.
        await tx
          .update(auditLog)
          .set({
            userId: null,
            contentExcerpt: '[deleted]',
            metadata: sql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('anonymized_at', NOW()::text)`,
          })
          .where(eq(auditLog.userId, userId));

        await tx.delete(users).where(eq(users.id, userId));
      });
      deps.logger.info({ userId }, 'user_deleted_gdpr');
    },
  };
}
