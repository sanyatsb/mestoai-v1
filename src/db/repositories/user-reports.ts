// user_reports repository.

import type { Database } from '../client.js';
import { type UserReport, userReports } from '../schema.js';

export interface NewUserReport {
  reporterUserId: number;
  messageId: number;
  reason?: string;
}

export interface UserReportsRepository {
  create(row: NewUserReport): Promise<UserReport>;
}

export function createUserReportsRepository(db: Database): UserReportsRepository {
  return {
    async create(row) {
      const [created] = await db
        .insert(userReports)
        .values({
          reporterUserId: row.reporterUserId,
          messageId: row.messageId,
          reason: row.reason ?? 'user_flag',
        })
        .returning();
      if (!created) throw new Error('user_reports.create returned no row');
      return created;
    },
  };
}
