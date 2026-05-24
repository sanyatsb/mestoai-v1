// [AUDIT-X10] auth middleware. Runs after i18n so any error/ban messages we
// emit go out in the user's language.
//
// Responsibilities for Week 2:
//   - Look up the user by tg_id (auto-create if missing).
//   - Inject the row as ctx.user.
//   - Bounce updates from users with a permanent ban or an unexpired
//     temporary ban with a localized message.
//
// Later weeks add ToS / age-gate redirects + CURRENT_TOS_VERSION refresh.

import type { MiddlewareFn } from 'grammy';
import type { MyContext } from '../context.js';

export const authMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next(); // service updates without a from — skip.

  const user = await ctx.services.users.getOrCreate({
    tgId: from.id,
    ...(from.username !== undefined ? { tgUsername: from.username } : {}),
    ...(from.first_name !== undefined ? { firstName: from.first_name } : {}),
    ...(from.language_code !== undefined ? { languageCode: from.language_code } : {}),
  });
  ctx.user = user;

  // [AUDIT-W6] full ban-reason copy lands in Week 6 (locales). For now we
  // use a generic maintenance message for permabans / active temp bans so
  // banned users get *something* rather than silence.
  if (user.bannedPermanent) {
    await ctx.reply(ctx.t('error.maintenance'));
    return;
  }
  if (user.bannedUntil && user.bannedUntil.getTime() > Date.now()) {
    await ctx.reply(ctx.t('error.maintenance'));
    return;
  }

  return next();
};
