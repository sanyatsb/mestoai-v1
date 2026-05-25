// audit_log repository — write only here, no UI surface yet.
//
// [AUDIT-B3] userId is NULLABLE so /delete_my_data can anonymize without
// losing the security trail.

import { lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type AuditLogEntry, type NewAuditLogEntry, auditLog } from '../schema.js';

export interface AuditLogRepository {
  create(row: NewAuditLogEntry): Promise<AuditLogEntry>;
  /** GDPR retention — invoked by node-cron daily in Week 7A. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export function createAuditLogRepository(db: Database): AuditLogRepository {
  return {
    async create(row) {
      const [created] = await db.insert(auditLog).values(row).returning();
      if (!created) throw new Error('audit_log.create returned no row');
      return created;
    },
    async deleteOlderThan(cutoff) {
      const result = await db
        .delete(auditLog)
        .where(lt(auditLog.createdAt, cutoff))
        .returning({ id: auditLog.id });
      return result.length;
    },
  };
}

// Re-export sql for the rare case a caller wants raw SQL helpers via this
// module. Drizzle's tree-shake keeps it free.
export { sql };
