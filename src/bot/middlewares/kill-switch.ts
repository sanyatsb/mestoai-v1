// [AUDIT-X10] kill-switch middleware. Runs AFTER auth so admins are
// always exempt: the admin needs to be able to /unkill even with the
// switch flipped.

import type { MiddlewareFn } from 'grammy';
import { env } from '../../config.js';
import type { MyContext } from '../context.js';

export const killSwitchMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  if (env.ADMIN_TG_IDS.includes(ctx.from?.id ?? 0)) return next();

  // env.KILL_SWITCH is the boot-time fallback; the Redis flag is the live
  // toggle owned by /kill /unkill and by CostTracker's auto-trip.
  const liveKill = await ctx.services.cost.isKillSwitchActive();
  if (liveKill || env.KILL_SWITCH) {
    await ctx.reply(ctx.t('error.maintenance'));
    return;
  }
  return next();
};
