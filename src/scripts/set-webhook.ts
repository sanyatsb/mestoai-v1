// Register / refresh the Telegram webhook. Run once after deploy:
//   pnpm tsx scripts/set-webhook.ts
// or in Docker:
//   docker compose exec bot node dist/scripts/set-webhook.js

import { Bot } from 'grammy';
import { env } from '../config.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  const bot = new Bot(env.BOT_TOKEN);
  await bot.init();
  await bot.api.setWebhook(env.WEBHOOK_URL, {
    secret_token: env.WEBHOOK_SECRET,
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query', 'edited_message'],
  });
  const info = await bot.api.getWebhookInfo();
  logger.info({ info }, 'webhook_set');
}

main().catch((e) => {
  logger.fatal({ err: e }, 'set_webhook_failed');
  process.exit(1);
});
