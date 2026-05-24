// Entry point.
//
// Week 1 lifecycle:
//   1. Validate env (already done at config.ts import).
//   2. Connect Postgres + Redis.
//   3. Build the bot (composers + middlewares).
//   4. Start Hono HTTP server (with /health, /ready, /webhook).
//   5. In dev: poll (bot.start) for instant feedback without ngrok.
//      In prod: rely on Telegram webhook → POST /webhook.
//   6. Wire SIGINT/SIGTERM for graceful shutdown.
//
// Later weeks add: services injector middleware (Week 2+), node-cron tasks
// (Week 6+), webhook registration via scripts/set-webhook.ts (Week 7B).

import { serve } from '@hono/node-server';
import { Redis } from 'ioredis';
import { createBot } from './bot/app.js';
import { env } from './config.js';
import { createDb } from './db/client.js';
import { createServer } from './http/server.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV, port: env.PORT }, 'bootstrap_start');

  // ---- storage ----
  const {
    db: _db,
    sql,
    ping: pingDb,
    close: closeDb,
  } = createDb({
    url: env.DATABASE_URL,
    logger,
  });
  // Keep a reference; _db will be passed to services in Week 2+.
  void _db;
  void sql;

  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  redis.on('error', (e) => logger.error({ err: e }, 'redis_error'));

  // ---- bot ----
  const bot = createBot();
  await bot.init();
  logger.info({ botUsername: bot.botInfo.username }, 'bot_initialized');

  // ---- http ----
  const app = createServer({
    bot,
    readiness: { pingDb, redis, logger },
    logger,
  });
  const httpServer = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port }, 'http_listening');
  });

  // ---- bot transport: polling in dev, webhook in prod ----
  if (env.NODE_ENV === 'development') {
    // In dev: poll for instant local testing without ngrok.
    bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username }, 'polling_started');
      },
    });
  } else {
    // In prod the webhook is registered separately via scripts/set-webhook.ts.
    logger.info('webhook_mode — POST /webhook should be reachable from Telegram');
  }

  // ---- graceful shutdown ----
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown_start');
    try {
      await bot.stop();
    } catch (e) {
      logger.warn({ err: e }, 'bot_stop_failed');
    }
    httpServer.close();
    await redis.quit().catch((e) => logger.warn({ err: e }, 'redis_quit_failed'));
    await closeDb().catch((e) => logger.warn({ err: e }, 'db_close_failed'));
    logger.info('shutdown_complete');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.fatal({ err: e }, 'bootstrap_failed');
  process.exit(1);
});
