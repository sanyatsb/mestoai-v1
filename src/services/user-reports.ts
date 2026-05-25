// UserReportsService — persist a /report + notify admin chat.

import type { UserReportsRepository } from '../db/repositories/user-reports.js';
import type { Logger, MessageId, UserId } from '../types.js';
import type { BotApiHandle } from './moderation.js';

export interface UserReportsService {
  create(opts: {
    reporterUserId: UserId;
    messageId: MessageId;
    reason?: string;
  }): Promise<{ id: number }>;
}

export interface UserReportsServiceDeps {
  reports: UserReportsRepository;
  bot: BotApiHandle;
  adminChatId: number;
  logger: Logger;
}

export function createUserReportsService(deps: UserReportsServiceDeps): UserReportsService {
  return {
    async create(opts) {
      const row = await deps.reports.create({
        reporterUserId: opts.reporterUserId as number,
        messageId: opts.messageId as number,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      });

      // Best-effort admin notification. Don't fail the user's /report on
      // Telegram glitches.
      try {
        await deps.bot.api.sendMessage(
          deps.adminChatId,
          `⚠️ User report #${row.id}\nReporter: ${opts.reporterUserId}\nMessage: ${opts.messageId}\nReason: ${opts.reason ?? 'user_flag'}`,
        );
      } catch (e) {
        deps.logger.warn({ err: e }, 'admin_report_notify_failed');
      }

      return { id: row.id };
    },
  };
}
