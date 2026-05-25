// Bot instance + middleware order + composer registration.
//
// [AUDIT-X10] Middleware order is load-bearing:
//   1. logging          — traceId / per-request child logger first
//   2. services-injector — ctx.services available below
//   3. i18n             — ctx.lang + ctx.t (so error msgs are localized)
//   4. auth             — lookup user, enforce ban
//   (Later weeks add: kill-switch after auth)
//
// Composers are appended in registration order. grammY dispatches to the
// first matching handler, so command composers go BEFORE the catch-all
// chat composer.

import { Bot } from 'grammy';
import { env } from '../config.js';
import { aboutComposer } from './composers/about.js';
import { chatComposer } from './composers/chat.js';
import { documentComposer } from './composers/document.js';
import { groupComposer } from './composers/group.js';
import { helpComposer } from './composers/help.js';
import { langComposer } from './composers/lang.js';
import { newComposer } from './composers/new.js';
import { personaComposer } from './composers/persona.js';
import { startComposer } from './composers/start.js';
import { voiceComposer } from './composers/voice.js';
import type { BotServices, MyContext } from './context.js';
import { authMiddleware } from './middlewares/auth.js';
import { i18nMiddleware } from './middlewares/i18n.js';
import { loggingMiddleware } from './middlewares/logging.js';
import { createServicesInjector } from './middlewares/services-injector.js';

export function createBot(services: BotServices): Bot<MyContext> {
  const bot = new Bot<MyContext>(env.BOT_TOKEN);

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

  // ---- catch-alls. Order matters: groups first (chatType-scoped) so we
  // don't accidentally run the private chat handler for group messages.
  bot.use(groupComposer);
  bot.use(chatComposer);

  // Generic safety net so one bad update doesn't crash polling/webhook.
  bot.catch((err) => {
    err.ctx.logger.error({ err: err.error }, 'unhandled_bot_error');
  });

  return bot;
}
