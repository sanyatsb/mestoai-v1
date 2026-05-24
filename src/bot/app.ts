// Bot instance + middleware order + composer registration.
//
// [AUDIT-X10] Middleware order is load-bearing:
//   1. logging      — establish traceId / child logger first
//   2. i18n         — ctx.lang + ctx.t available everywhere below
//   (Later weeks add: services-injector, auth, kill-switch)
//
// The rest of the file just wires composers in registration order. grammY
// dispatches to the first matching handler, so order matters only for
// catch-all message handlers (chat / group), which we'll add at the END
// in later weeks.

import { Bot } from 'grammy';
import { env } from '../config.js';
import { helpComposer } from './composers/help.js';
import { startComposer } from './composers/start.js';
import type { MyContext } from './context.js';
import { i18nMiddleware } from './middlewares/i18n.js';
import { loggingMiddleware } from './middlewares/logging.js';

export function createBot(): Bot<MyContext> {
  const bot = new Bot<MyContext>(env.BOT_TOKEN);

  // ---- middleware order ----
  bot.use(loggingMiddleware);
  bot.use(i18nMiddleware);

  // ---- composers ----
  bot.use(startComposer);
  bot.use(helpComposer);

  // Generic error handler so a single bad update doesn't crash polling/webhook.
  bot.catch((err) => {
    err.ctx.logger.error({ err: err.error }, 'unhandled_bot_error');
  });

  return bot;
}
