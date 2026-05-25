// Admin commands: /kill, /unkill, /stats.
//
// Admin check is by tg_id against env.ADMIN_TG_IDS (parsed into a number[]
// at startup). The kill-switch middleware is what actually blocks regular
// users — these commands just flip the Redis flag.

import { Composer } from 'grammy';
import type { Redis } from 'ioredis';
import { env } from '../../config.js';
import type { MyContext } from '../context.js';

const KILL_KEY = 'kill_switch';

/**
 * The Redis handle isn't on ctx.services (services-injector only exposes
 * the bot-relevant services). We grab it via a factory so main.ts can pass
 * the same Redis instance the rest of the app is using.
 */
export function createAdminComposer(redis: Redis): Composer<MyContext> {
  const admin = new Composer<MyContext>();

  admin.command('kill', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply(ctx.t('admin.not_authorized'));
      return;
    }
    // 24h TTL so a forgotten kill switch self-clears.
    await redis.set(KILL_KEY, '1', 'EX', 86_400);
    await ctx.reply(ctx.t('admin.kill_on'));
    ctx.logger.warn({ adminTgId: ctx.from?.id }, 'kill_switch_engaged');
  });

  admin.command('unkill', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply(ctx.t('admin.not_authorized'));
      return;
    }
    await redis.del(KILL_KEY);
    await ctx.reply(ctx.t('admin.kill_off'));
    ctx.logger.warn({ adminTgId: ctx.from?.id }, 'kill_switch_released');
  });

  admin.command('stats', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply(ctx.t('admin.not_authorized'));
      return;
    }
    const t = await ctx.services.cost.totalsToday();
    await ctx.reply(
      ctx.t('admin.stats', {
        dau: t.dau,
        textMsgs: t.textMessages,
        voiceMsgs: t.voiceMessages,
        docs: t.documents,
        costUsd: t.costUsd.toFixed(4),
      }),
    );
  });

  return admin;
}

function isAdmin(ctx: MyContext): boolean {
  return env.ADMIN_TG_IDS.includes(ctx.from?.id ?? 0);
}
