// /delete_my_data — GDPR Article 17 (right to erasure).
//
// [AUDIT-A1, B3] Two-step confirm. On confirm, deleteCascade hard-deletes
// the user's conversations/messages/usage/reports and anonymizes their
// audit_log rows.

import { Composer, InlineKeyboard } from 'grammy';
import type { MyContext } from '../context.js';

export const deleteDataComposer = new Composer<MyContext>();

const PREFIX = 'delete:';

deleteDataComposer.command('delete_my_data', async (ctx) => {
  if (!ctx.user) return;
  const kb = new InlineKeyboard()
    .text(ctx.t('delete.yes_delete'), `${PREFIX}confirm`)
    .text(ctx.t('delete.cancel'), `${PREFIX}cancel`);
  await ctx.reply(ctx.t('delete.confirm'), { reply_markup: kb });
});

deleteDataComposer.callbackQuery(new RegExp(`^${PREFIX}`), async (ctx) => {
  const data = ctx.callbackQuery.data ?? '';
  const user = ctx.user;
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Auth required' });
    return;
  }

  if (data === `${PREFIX}cancel`) {
    try {
      await ctx.editMessageText(ctx.t('delete.cancelled'));
    } catch {
      // editMessageText can fail if the menu is too old — ignore.
    }
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === `${PREFIX}confirm`) {
    await ctx.services.users.deleteCascade(user.id);
    try {
      await ctx.editMessageText(ctx.t('delete.done'));
    } catch {
      // ignore
    }
    ctx.logger.info({ tgId: ctx.from?.id }, 'user_deleted_gdpr_via_command');
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' });
});
