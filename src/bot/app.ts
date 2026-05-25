// Bot instance + middleware order + composer registration.
//
// [AUDIT-X10] Middleware order is load-bearing:
//   1. logging          — traceId / per-request child logger first
//   2. services-injector — ctx.services available below
//   3. i18n             — ctx.lang + ctx.t (so error msgs are localized)
//   4. auth             — lookup user, enforce ban
//   (Later weeks add: kill-switch after auth)
//
// Construction is split into createBotInstance() + attachComposers() so
// services that need bot.api (notifyAdmin from moderation + user-reports)
// can be built between the two steps without a circular dependency.

import { Bot } from 'grammy';
import { env } from '../config.js';
import { aboutComposer } from './composers/about.js';
import { chatComposer } from './composers/chat.js';
import { deleteDataComposer } from './composers/delete-data.js';
import { documentComposer } from './composers/document.js';
import { groupComposer } from './composers/group.js';
import { helpComposer } from './composers/help.js';
import { langComposer } from './composers/lang.js';
import { newComposer } from './composers/new.js';
import { personaComposer } from './composers/persona.js';
import { reportComposer } from './composers/report.js';
import { startComposer } from './composers/start.js';
import { voiceComposer } from './composers/voice.js';
import type { BotServices, MyContext } from './context.js';
import { authMiddleware } from './middlewares/auth.js';
import { i18nMiddleware } from './middlewares/i18n.js';
import { loggingMiddleware } from './middlewares/logging.js';
import { createServicesInjector } from './middlewares/services-injector.js';

/** Build the empty bot. No middleware / composers attached yet. */
export function createBotInstance(): Bot<MyContext> {
  return new Bot<MyContext>(env.BOT_TOKEN);
}

/**
 * Attach middleware + composers. Call AFTER services that depend on
 * bot.api (e.g. moderation/userReports for admin notifications) have been
 * constructed using the bot instance returned by createBotInstance.
 */
export function attachComposers(bot: Bot<MyContext>, services: BotServices): void {
  // ---- middleware order ----
  bot.use(loggingMiddleware);
  bot.use(createServicesInjector(services));
  bot.use(i18nMiddleware);
  bot.use(authMiddleware);

  // ---- command + callback composers (run BEFORE catch-alls) ----
  bot.use(startComposer);
  bot.use(helpComposer);
  bot.use(aboutComposer);
  bot.use(newComposer);
  bot.use(personaComposer);
  bot.use(voiceComposer);
  bot.use(documentComposer);
  bot.use(langComposer);
  bot.use(reportComposer);
  bot.use(deleteDataComposer);

  // ---- catch-alls. Order matters: groups first (chatType-scoped) so we
  // don't accidentally run the private chat handler for group messages.
  bot.use(groupComposer);
  bot.use(chatComposer);

  // Generic safety net so one bad update doesn't crash polling/webhook.
  bot.catch((err) => {
    err.ctx.logger.error({ err: err.error }, 'unhandled_bot_error');
  });
}
