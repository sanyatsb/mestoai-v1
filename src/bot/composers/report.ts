// /report — flag a specific bot reply for human review.
//
// [AUDIT-H8] Target resolution order:
//   1. If the user invokes /report as a reply to a bot message we recognize
//      (matched by tg_message_id within the user's active conversation) →
//      use that message.
//   2. Otherwise → fall back to the most recent assistant message in the
//      user's active conversation.
//   3. Otherwise → "nothing to report" hint.

import { Composer } from 'grammy';
import { toUserId } from '../../utils/ids.js';
import type { MyContext } from '../context.js';

export const reportComposer = new Composer<MyContext>();

reportComposer.command('report', async (ctx) => {
  const user = ctx.user;
  if (!user) return;

  const conv = await ctx.services.conversation.getOrCreateActive(toUserId(user.id));

  let targetMessageId: Awaited<ReturnType<typeof ctx.services.conversation.findMessageByTgId>> =
    null;

  // 1. Reply to a bot message?
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.id === ctx.me.id) {
    targetMessageId = await ctx.services.conversation.findMessageByTgId(
      conv.id,
      replyTo.message_id,
    );
  }

  // 2. Fall back to last assistant turn.
  if (!targetMessageId) {
    targetMessageId = await ctx.services.conversation.lastAssistantMessage(conv.id);
  }

  if (!targetMessageId) {
    await ctx.reply(ctx.t('report.nothing_to_report'));
    return;
  }

  const reason = (ctx.message?.text ?? '').replace(/^\/report\s*/, '').trim() || 'user_flag';
  await ctx.services.userReports.create({
    reporterUserId: toUserId(user.id),
    messageId: targetMessageId,
    reason,
  });

  await ctx.reply(ctx.t('report.thanks'));
});
