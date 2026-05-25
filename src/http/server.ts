// Hono HTTP server wiring.
//
// Mounts /health, /ready, and the grammY webhook callback. The actual
// listen() call is in main.ts via @hono/node-server.

import type { Bot } from 'grammy';
import { webhookCallback } from 'grammy';
import { Hono } from 'hono';
import type { MyContext } from '../bot/context.js';
import { env } from '../config.js';
import type { Logger } from '../types.js';
import { registerHealth } from './health.js';
import { type ReadinessChecks, registerReady } from './ready.js';

export interface ServerDeps {
  bot: Bot<MyContext>;
  readiness: ReadinessChecks;
  logger: Logger;
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();

  registerHealth(app);
  registerReady(app, deps.readiness);

  // In development we run on long-polling — calling webhookCallback() here
  // would overwrite bot.start to throw and break dev mode. The webhook
  // route only exists in production / test, where Telegram POSTs to it.
  //
  // [AUDIT-C10] grammY validates the X-Telegram-Bot-Api-Secret-Token
  // header inside webhookCallback. Caddy must forward this header.
  if (env.NODE_ENV !== 'development') {
    app.post(
      env.WEBHOOK_PATH,
      webhookCallback(deps.bot, 'hono', {
        secretToken: env.WEBHOOK_SECRET,
      }),
    );
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    deps.logger.error({ err }, 'http_error');
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
