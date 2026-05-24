// /persona — pick a persona via inline keyboard.
//
// Switching persona starts a fresh conversation [TZ §8.5] so the new
// persona doesn't inherit context from the old one. startNew is
// transactional [AUDIT-N4] so this can't violate the partial unique index
// even if /persona races with an incoming message.

import { Composer } from 'grammy';
import type { PersonaSlug } from '../../services/persona.js';
import type { MyContext } from '../context.js';
import { PERSONA_CALLBACK_PREFIX, buildPersonaKeyboard } from '../keyboards/personas.js';

export const personaComposer = new Composer<MyContext>();

personaComposer.command('persona', async (ctx) => {
  const personas = await ctx.services.persona.listActive();
  await ctx.reply(ctx.t('persona.choose'), {
    reply_markup: buildPersonaKeyboard(personas, (key) => ctx.t(key)),
  });
});

personaComposer.callbackQuery(new RegExp(`^${PERSONA_CALLBACK_PREFIX}`), async (ctx) => {
  const user = ctx.user;
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Auth required' });
    return;
  }
  const data = ctx.callbackQuery.data ?? '';
  const slug = data.slice(PERSONA_CALLBACK_PREFIX.length) as PersonaSlug;

  const chosen = await ctx.services.persona.getBySlug(slug);
  if (!chosen) {
    await ctx.answerCallbackQuery({ text: 'Not found' });
    return;
  }

  // [AUDIT-N4] startNew transactionally deactivates the old DM conversation
  // before inserting the new one.
  const conv = await ctx.services.conversation.startNew(user.id as never, {
    personaId: chosen.id,
  });
  await ctx.services.users.update(user.id, {
    activePersonaId: chosen.id as number,
    activeConversationId: conv.id as number,
  });

  try {
    await ctx.editMessageText(ctx.t('persona.selected', { name: ctx.t(chosen.nameKey) }));
  } catch {
    // editMessageText fails if the message is too old / already edited — that's fine.
  }
  await ctx.answerCallbackQuery();
});
