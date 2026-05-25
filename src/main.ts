// Entry point. Composition root — builds services once, injects them into
// the bot via middleware, then starts the HTTP server and (in dev) polling.

import { serve } from '@hono/node-server';
import { Redis } from 'ioredis';
import { createBot } from './bot/app.js';
import type { BotServices } from './bot/context.js';
import { env } from './config.js';
import { createDb } from './db/client.js';
import { createConversationsRepository } from './db/repositories/conversations.js';
import { createMessagesRepository } from './db/repositories/messages.js';
import { createPersonasRepository } from './db/repositories/personas.js';
import { createUsersRepository } from './db/repositories/users.js';
import { createServer } from './http/server.js';
import { createConversationService } from './services/conversation.js';
import { createDocumentService } from './services/document.js';
import { createGonkaClient } from './services/gonka-client.js';
import { createI18nService } from './services/i18n.js';
import { createPersonaService } from './services/persona.js';
import { createRateLimiter } from './services/rate-limiter.js';
import { createUsersService } from './services/users.js';
import { createVoiceService } from './services/voice.js';
import { logger } from './utils/logger.js';
import { createTokenizer } from './utils/tokenizer.js';

async function main(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV, port: env.PORT }, 'bootstrap_start');

  // ---- storage ----
  const dbHandle = createDb({ url: env.DATABASE_URL, logger });
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  redis.on('error', (e) => logger.error({ err: e }, 'redis_error'));

  // ---- repositories ----
  const usersRepo = createUsersRepository(dbHandle.db);
  const conversationsRepo = createConversationsRepository(dbHandle.db);
  const messagesRepo = createMessagesRepository(dbHandle.db);
  const personasRepo = createPersonasRepository(dbHandle.db);

  // ---- services ----
  const tokenizer = createTokenizer();
  const i18n = createI18nService(logger);
  const users = createUsersService({ users: usersRepo, logger });
  const conversation = createConversationService({
    db: dbHandle.db,
    conversations: conversationsRepo,
    messages: messagesRepo,
    tokenizer,
    logger,
  });
  const rateLimit = createRateLimiter({
    redis,
    limits: {
      text: env.RATE_LIMIT_TEXT_PER_DAY,
      voice: env.RATE_LIMIT_VOICE_PER_DAY,
      document: env.RATE_LIMIT_DOCUMENT_PER_DAY,
    },
    logger,
  });
  const gonka = createGonkaClient({
    baseUrl: env.GONKA_GATEWAY_URL,
    apiKey: env.GONKA_API_KEY,
    model: env.GONKA_MODEL,
    timeoutMs: env.GONKA_TIMEOUT_MS,
    maxRetries: env.GONKA_MAX_RETRIES,
    logger,
  });
  const persona = createPersonaService({ personas: personasRepo, logger });
  const voice = createVoiceService({
    openaiApiKey: env.OPENAI_API_KEY,
    whisperModel: env.OPENAI_WHISPER_MODEL,
    logger,
  });
  const document = createDocumentService({ tokenizer, logger });

  const services: BotServices = {
    gonka,
    conversation,
    rateLimit,
    tokenizer,
    users,
    i18n,
    persona,
    voice,
    document,
  };

  // ---- bot ----
  const bot = createBot(services);
  await bot.init();
  logger.info({ botUsername: bot.botInfo.username }, 'bot_initialized');

  // ---- http ----
  const app = createServer({
    bot,
    readiness: { pingDb: dbHandle.ping, redis, logger },
    logger,
  });
  const httpServer = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port }, 'http_listening');
  });

  // ---- bot transport ----
  if (env.NODE_ENV === 'development') {
    bot.start({
      onStart: (botInfo) => logger.info({ username: botInfo.username }, 'polling_started'),
    });
  } else {
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
    await dbHandle.close().catch((e) => logger.warn({ err: e }, 'db_close_failed'));
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
