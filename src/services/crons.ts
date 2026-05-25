// [AUDIT-L11] node-cron task registration.
//
// Currently we only need one task — GDPR audit-log retention. CostTracker's
// alert dedup window is handled by Redis TTL (AUDIT-B1), so there's no
// resetDailyFlags cron.

import cron from 'node-cron';
import type { AuditLogRepository } from '../db/repositories/audit-log.js';
import type { Logger } from '../types.js';

const AUDIT_RETENTION_DAYS = 30;

export interface CronsDeps {
  auditLog: AuditLogRepository;
  logger: Logger;
}

export function registerCrons(deps: CronsDeps): void {
  // Daily at 03:00 UTC — quiet hours globally, doesn't compete with peak load.
  cron.schedule(
    '0 3 * * *',
    async () => {
      const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      try {
        const deleted = await deps.auditLog.deleteOlderThan(cutoff);
        deps.logger.info({ deleted, retentionDays: AUDIT_RETENTION_DAYS }, 'audit_log_cleanup');
      } catch (e) {
        deps.logger.error({ err: e }, 'audit_log_cleanup_failed');
      }
    },
    { timezone: 'UTC' },
  );

  deps.logger.info('crons_registered');
}
