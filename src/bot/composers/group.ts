// [AUDIT-C9, N2, N3, P5, X12] group composer.
//
// Privacy mode is ON in BotFather, so the only updates that reach us in a
// group are:
//   - messages containing @bot_username (mention entity)
//   - direct /commands aimed at the bot
//   - replies to bot messages that also @mention the bot
//
// MVP: single-turn replies only. No persistent conversation per group thread
// (Phase 2 backlog). Each @mention → one minimal {system, user} pair sent
// straight to Kimi → reply quoted on the user's message.
//
// Strictly NO voice output in groups (AUDIT-N3) and NO document attachment
// (groups can't upload through this path anyway since we only listen to
// mentions, but the chat composer's voice-output branch already gates on
// chat.type === 'private').

import { Composer } from 'grammy';
import { env } from '../../config.js';
import type { ChatMessage } from '../../services/conversation.js';
import { createTypingIndicatorSink } from '../../services/streaming-sink.js';
import { extractTextWithoutMention } from '../../utils/extract-mention.js';
import { splitForTelegram } from '../../utils/telegram-split.js';
import type { MyContext } from '../context.js';

export const groupComposer = new Composer<MyContext>();

// We deliberately listen to text in groups + supergroups only. Channels are
// excluded (they go through a different update type and Privacy mode would
// trim them out anyway).
groupComposer.chatType(['group', 'supergroup']).on('message:text', async (ctx) => {
  if (!env.FEATURE_GROUPS) return;
  const user = ctx.user;
  if (!user) return;

  // [AUDIT-C9] DM-first ToS gate. Once Week 7A wires the real ToS flow we
  // can check user.tosAcceptedAt here too — for now any user the auth
  // middleware created is allowed through, but we send the must_start_dm
  // message if their DM ToS hasn't been accepted yet.
  if (user.tosAcceptedAt == null) {
    const replyMsgId = ctx.message?.message_id;
    await ctx.reply(
      ctx.t('group.must_start_dm_first', {
        botLink: `https://t.me/${env.BOT_USERNAME}`,
      }),
      replyMsgId != null ? { reply_parameters: { message_id: replyMsgId } } : undefined,
    );
    return;
  }

  const msg = ctx.message;
  if (!msg) return;

  // Strip @mention / leading /command from the text. If nothing remains,
  // the user typed only "@bot" with no question — silently ignore.
  const userText = extractTextWithoutMention(msg, env.BOT_USERNAME);
  if (!userText || userText.length < 2) return;

  if (userText.length > env.MAX_MESSAGE_LENGTH_CHARS) {
    await ctx.reply(ctx.t('error.message_too_long', { limit: env.MAX_MESSAGE_LENGTH_CHARS }), {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }

  // Rate-limit lives on the same 'text' bucket as DM messages — power
  // users shouldn't get 2x the budget just by switching to a group.
  const rl = await ctx.services.rateLimit.checkAndIncrement(user.id as never, 'text');
  if (!rl.allowed) {
    await ctx.reply(
      ctx.t('rate_limit.text', {
        current: rl.current,
        limit: rl.limit,
        hours: Math.ceil(rl.resetsInSec / 3600),
      }),
      { reply_parameters: { message_id: msg.message_id } },
    );
    return;
  }

  // Week 6 will add input moderation here.

  // Single-turn: just the default persona, no history.
  const defaultPersona = await ctx.services.persona.getDefault();
  const systemPrompt = ctx.services.persona.renderSystemPrompt({
    persona: defaultPersona,
    userLang: ctx.lang,
  });

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];

  // [AUDIT-N2] The sink replies to the user's original message so the
  // group thread context is obvious. Typing indicator fires in the group
  // chat itself.
  const sink = createTypingIndicatorSink({ ctx, replyToMessageId: msg.message_id });
  let accumulated = '';

  try {
    for await (const chunk of ctx.services.gonka.chatStream({ messages: llmMessages })) {
      accumulated += chunk.delta;
      if (chunk.delta) await sink.push(chunk.delta);
    }
  } catch (e) {
    await sink.abort();
    ctx.logger.error({ err: e, userId: user.id }, 'group_gonka_stream_failed');
    await ctx.reply(ctx.t('error.service_unavailable'), {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }

  if (accumulated.length === 0) {
    await sink.abort();
    await ctx.reply(ctx.t('error.service_unavailable'), {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }

  // Week 6: output moderation goes RIGHT HERE — before sink.commit.

  // [AUDIT-A4] Split long replies. First chunk replaces the typing
  // indicator (as a reply to the user); follow-ups are regular replies
  // to keep the thread visually anchored.
  const parts = splitForTelegram(accumulated, 4000);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (i === 0) {
      await sink.commit(part);
    } else {
      await ctx.reply(part, { reply_parameters: { message_id: msg.message_id } });
    }
  }

  // No appendMessage — group turns are stateless in MVP [AUDIT-P5].
  // No voice output — never in groups [AUDIT-N3].
});
