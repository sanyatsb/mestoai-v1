// Entry point. Composition root — builds services once, injects them into
// the bot via middleware, then starts the HTTP server and (in dev) polling.

import { serve } from '@hono/node-server';
import { Redis } from 'ioredis';
import { attachComposers, createBotInstance } from './bot/app.js';
import { createAdminComposer } from './bot/composers/admin.js';
import type { BotServices } from './bot/context.js';
import { env } from './config.js';
import { createDb } from './db/client.js';
import { createAuditLogRepository } from './db/repositories/audit-log.js';
import { createConversationsRepository } from './db/repositories/conversations.js';
import { createMessagesRepository } from './db/repositories/messages.js';
import { createPersonasRepository } from './db/repositories/personas.js';
import { createUsageStatsRepository } from './db/repositories/usage-stats.js';
import { createUserReportsRepository } from './db/repositories/user-reports.js';
import { createUsersRepository } from './db/repositories/users.js';
import { createServer } from './http/server.js';
import { createBlacklistChecker } from './services/blacklist-checker.js';
import { createConversationService } from './services/conversation.js';
import { createCostTracker } from './services/cost-tracker.js';
import { registerCrons } from './services/crons.js';
import { createDocumentService } from './services/document.js';
import { createGonkaClient } from './services/gonka-client.js';
import { createI18nService } from './services/i18n.js';
import { createJailbreakDetector } from './services/jailbreak-detector.js';
import { createModerationService } from './services/moderation.js';
import { createPersonaService } from './services/persona.js';
import { createRateLimiter } from './services/rate-limiter.js';
import { createUserReportsService } from './services/user-reports.js';
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
  const auditLogRepo = createAuditLogRepository(dbHandle.db);
  const userReportsRepo = createUserReportsRepository(dbHandle.db);
  const usageStatsRepo = createUsageStatsRepository(dbHandle.db);

  // ---- services ----
  const tokenizer = createTokenizer();
  const i18n = createI18nService(logger);
  const users = createUsersService({ db: dbHandle.db, users: usersRepo, logger });
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
    baseUrl: env.LLM_GATEWAY_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxRetries: env.LLM_MAX_RETRIES,
    logger,
  });
  const persona = createPersonaService({ personas: personasRepo, logger });
  const voice = createVoiceService({
    openaiApiKey: env.OPENAI_API_KEY,
    whisperModel: env.OPENAI_WHISPER_MODEL,
    logger,
  });
  const document = createDocumentService({ tokenizer, logger });

  // Bot instance is needed by moderation + reports services so they can DM
  // the admin chat. We build it first (no composers attached yet), construct
  // the services that use bot.api, then attach composers via attachComposers
  // below.
  const bot = createBotInstance();

  const jailbreak = createJailbreakDetector();
  const blacklist = createBlacklistChecker(logger);
  const moderation = createModerationService({
    openaiApiKey: env.OPENAI_API_KEY,
    moderationModel: env.OPENAI_MODERATION_MODEL,
    jailbreak,
    blacklist,
    users: usersRepo,
    auditLog: auditLogRepo,
    thresholds: {
      sexualMinors: env.MOD_THRESHOLD_SEXUAL_MINORS,
      harm: env.MOD_THRESHOLD_HARM,
      violence: env.MOD_THRESHOLD_VIOLENCE,
      hate: env.MOD_THRESHOLD_HATE,
      selfHarm: env.MOD_THRESHOLD_SELF_HARM,
      sexual: env.MOD_THRESHOLD_SEXUAL,
    },
    banFlagThreshold: env.USER_BAN_FLAG_THRESHOLD,
    permabanFlagThreshold: env.USER_PERMABAN_FLAG_THRESHOLD,
    bot,
    adminChatId: env.ADMIN_CHAT_ID,
    logger,
    enabled: env.FEATURE_MODERATION,
  });
  const userReports = createUserReportsService({
    reports: userReportsRepo,
    bot,
    adminChatId: env.ADMIN_CHAT_ID,
    logger,
  });
  const cost = createCostTracker({
    usageStats: usageStatsRepo,
    redis,
    bot,
    config: {
      dailyBudgetUsd: env.DAILY_BUDGET_USD,
      alertThresholdUsd: env.COST_ALERT_THRESHOLD_USD,
      costPerInputToken: env.COST_PER_INPUT_TOKEN_USD,
      costPerOutputToken: env.COST_PER_OUTPUT_TOKEN_USD,
      adminChatId: env.ADMIN_CHAT_ID,
    },
    logger,
  });

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
    moderation,
    userReports,
    cost,
  };

  // Admin composer needs the raw Redis handle for /kill / /unkill (it
  // toggles the same key CostTracker reads from). Built here so we don't
  // expose Redis through ctx.services.
  const adminComposer = createAdminComposer(redis);

  // Now that services are built, install composers + middlewares onto the
  // bot instance we created above and init the bot's API metadata.
  attachComposers(bot, services, adminComposer);
  await bot.init();
  logger.info({ botUsername: bot.botInfo.username }, 'bot_initialized');

  // [AUDIT-L11] node-cron tasks (audit-log GDPR retention).
  registerCrons({ auditLog: auditLogRepo, logger });

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
    // grammY refuses to long-poll if a webhook is registered with Telegram.
    // The flag persists across restarts (it lives on Telegram's side), so we
    // always clear it before starting polling. drop_pending_updates flushes
    // anything queued for the old webhook so a stale CSAM payload from
    // testing yesterday doesn't replay on today's restart.
    await bot.api.deleteWebhook({ drop_pending_updates: true });
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
