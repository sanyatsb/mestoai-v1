// /new — reset the active conversation.
//
// [AUDIT-X8, N4] startNew() is already transactional, so it both deactivates
// the current active DM conversation and inserts a fresh one without
// racing the partial unique index.

import { Composer } from 'grammy';
import type { MyContext } from '../context.js';

export const newComposer = new Composer<MyContext>();

newComposer.command('new', async (ctx) => {
  const user = ctx.user;
  if (!user) return;

  const conv = await ctx.services.conversation.startNew(user.id as never, {
    ...(user.activePersonaId != null ? { personaId: user.activePersonaId as never } : {}),
  });
  await ctx.services.users.update(user.id, { activeConversationId: conv.id as number });
  await ctx.reply(ctx.t('new_conversation.confirmed'));
});
