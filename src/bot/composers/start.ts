// /start — onboarding flow: ToS → age gate → welcome.
//
// [AUDIT-H9] Users who answered "No, under 18" are blocked from re-running
// /start for env.AGE_REJECTION_BLOCK_DAYS days — we set users.ageRejectedAt
// on the No callback and short-circuit /start while the cooldown lasts.
//
// [AUDIT-H10] If the user's stored tos_version doesn't match env's current
// version, we re-run them through the ToS flow with an "updated" notice.
//
// The bulk of the flow is callback-driven (Accept / Read / Yes / No) and
// lives in the same composer.

import { Composer } from 'grammy';
import { env } from '../../config.js';
import type { MyContext } from '../context.js';
import {
  AGE_CALLBACK_PREFIX,
  TOS_CALLBACK_PREFIX,
  buildAgeKeyboard,
  buildTosAcceptKeyboard,
  buildTosIntroKeyboard,
} from '../keyboards/tos.js';

export const startComposer = new Composer<MyContext>();

const MS_PER_DAY = 24 * 60 * 60 * 1000;

startComposer.command('start', async (ctx) => {
  const user = ctx.user;
  if (!user) return;

  // [AUDIT-H9] Age rejection cooldown — fires before any ToS / age path.
  if (user.ageRejectedAt) {
    const elapsedDays = Math.floor((Date.now() - user.ageRejectedAt.getTime()) / MS_PER_DAY);
    if (elapsedDays < env.AGE_REJECTION_BLOCK_DAYS) {
      const daysLeft = env.AGE_REJECTION_BLOCK_DAYS - elapsedDays;
      await ctx.reply(ctx.t('age.blocked', { daysLeft }));
      return;
    }
    // Cooldown elapsed — clear the rejection so the user can try again.
    await ctx.services.users.update(user.id, { ageRejectedAt: null });
    user.ageRejectedAt = null;
  }

  // [AUDIT-H10] Version mismatch → force re-accept.
  const tosOutdated = user.tosAcceptedAt != null && user.tosVersion !== env.CURRENT_TOS_VERSION;
  if (tosOutdated) {
    await ctx.services.users.update(user.id, {
      tosAcceptedAt: null,
      tosVersion: null,
    });
    user.tosAcceptedAt = null;
    user.tosVersion = null;
    await ctx.reply(ctx.t('tos.updated_notice'));
  }

  if (user.tosAcceptedAt == null) {
    await ctx.reply(ctx.t('tos.intro'), { reply_markup: buildTosIntroKeyboard(ctx) });
    return;
  }

  if (user.ageConfirmedAt == null) {
    await ctx.reply(ctx.t('age.question'), { reply_markup: buildAgeKeyboard(ctx) });
    return;
  }

  // Fully onboarded — show the welcome text.
  await ctx.reply(ctx.t('welcome.text'));
});

// ---- ToS callbacks ----

startComposer.callbackQuery(new RegExp(`^${TOS_CALLBACK_PREFIX}`), async (ctx) => {
  const user = ctx.user;
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Auth required' });
    return;
  }
  const action = (ctx.callbackQuery.data ?? '').slice(TOS_CALLBACK_PREFIX.length);

  if (action === 'read') {
    await ctx.reply(ctx.t('tos.full', { version: env.CURRENT_TOS_VERSION }), {
      reply_markup: buildTosAcceptKeyboard(ctx),
    });
    await ctx.answerCallbackQuery();
    return;
  }

  if (action === 'accept') {
    await ctx.services.users.update(user.id, {
      tosAcceptedAt: new Date(),
      tosVersion: env.CURRENT_TOS_VERSION,
    });
    user.tosAcceptedAt = new Date();
    user.tosVersion = env.CURRENT_TOS_VERSION;

    // Old inline keyboard is left in place — clearing it via
    // editMessageReplyMarkup({ reply_markup: undefined }) clashes with
    // exactOptionalPropertyTypes, and the next reply pushes the menu
    // out of immediate view anyway.
    await ctx.answerCallbackQuery();

    // If age not yet confirmed, jump straight to age gate.
    if (user.ageConfirmedAt == null) {
      await ctx.reply(ctx.t('age.question'), { reply_markup: buildAgeKeyboard(ctx) });
      return;
    }
    await ctx.reply(ctx.t('welcome.text'));
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' });
});

// ---- Age callbacks ----

startComposer.callbackQuery(new RegExp(`^${AGE_CALLBACK_PREFIX}`), async (ctx) => {
  const user = ctx.user;
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Auth required' });
    return;
  }
  const action = (ctx.callbackQuery.data ?? '').slice(AGE_CALLBACK_PREFIX.length);

  if (action === 'yes') {
    await ctx.services.users.update(user.id, { ageConfirmedAt: new Date() });
    // See note above re: leaving the old keyboard.
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('welcome.text'));
    return;
  }

  if (action === 'no') {
    await ctx.services.users.update(user.id, { ageRejectedAt: new Date() });
    // See note above re: leaving the old keyboard.
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('age.under18'));
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' });
});
