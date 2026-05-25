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
import { extractTextWithoutMention } from '../../utils/extract-mention.js';
import { splitForTelegram } from '../../utils/telegram-split.js';
import type { MyContext } from '../context.js';
import { createSinkForCtx } from './chat.js';

export const groupComposer = new Composer<MyContext>();

// We deliberately listen to text in groups + supergroups only. Channels are
// excluded (they go through a different update type and Privacy mode would
// trim them out anyway).
groupComposer.chatType(['group', 'supergroup']).on('message:text', async (ctx) => {
  if (!env.FEATURE_GROUPS) return;
  const user = ctx.user;
  if (!user) return;

  // NOTE: DM-first ToS gate intentionally removed for now — group members
  // should be able to invoke the bot without an explicit /start in DM
  // first. Re-add `if (user.tosAcceptedAt == null) reply(group.must_start_dm_first)`
  // here once we want to require DM ToS before any group activity.

  const msg = ctx.message;
  if (!msg) return;

  // Defense in depth: even with BotFather Privacy ON we double-check there's
  // an actual @mention of this bot in the message before doing anything.
  // If Privacy is somehow OFF, the bot would otherwise reply to EVERY
  // message in the group — runaway cost + privacy disaster.
  const lowerUsername = env.BOT_USERNAME.toLowerCase();
  const mentionsBot = (msg.entities ?? []).some((e) => {
    if (e.type !== 'mention') return false;
    const slice = (msg.text ?? '').slice(e.offset, e.offset + e.length).toLowerCase();
    return slice === `@${lowerUsername}`;
  });
  if (!mentionsBot) return; // silent — not addressed to us

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

  // [AUDIT-C7] Input moderation BEFORE we call Kimi.
  const modIn = await ctx.services.moderation.checkInput(userText, user.id as never, ctx.lang);
  if (modIn.decision === 'block') {
    await ctx.reply(ctx.t('moderation.input_blocked'), {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }

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

  // [AUDIT-N2] Sink replies to the user's original message so the group
  // thread context is obvious. Same sink type as DM — toggled via
  // STREAMING_USE_EDIT (defined in chat composer).
  const sink = createSinkForCtx(ctx, msg.message_id);
  let accumulated = '';
  let finalUsage: { tokensInput: number; tokensOutput: number } | null = null;
  const llmStart = Date.now();
  let firstTokenAtMs: number | null = null;

  try {
    for await (const chunk of ctx.services.gonka.chatStream({ messages: llmMessages })) {
      if (chunk.delta && firstTokenAtMs == null) firstTokenAtMs = Date.now() - llmStart;
      accumulated += chunk.delta;
      if (chunk.delta) await sink.push(chunk.delta);
      if (chunk.done && chunk.tokensInput != null && chunk.tokensOutput != null) {
        finalUsage = { tokensInput: chunk.tokensInput, tokensOutput: chunk.tokensOutput };
      }
    }
  } catch (e) {
    await sink.abort();
    ctx.logger.error({ err: e, userId: user.id }, 'group_llm_stream_failed');
    await ctx.reply(ctx.t('error.service_unavailable'), {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }
  ctx.logger.info(
    {
      phase: 'llm_stream',
      latencyMs: Date.now() - llmStart,
      ttftMs: firstTokenAtMs,
      chars: accumulated.length,
      tokensInput: finalUsage?.tokensInput,
      tokensOutput: finalUsage?.tokensOutput,
      surface: 'group',
    },
    'phase_timing',
  );

  if (accumulated.length === 0) {
    await sink.abort();
    await ctx.reply(ctx.t('error.service_unavailable'), {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }

  // Output moderation; on flag the streaming-edit sink overwrites the body
  // via replaceWith. Hidden-buffer sink just doesn't show anything.
  const modOut = await ctx.services.moderation.checkOutput(accumulated, user.id as never, ctx.lang);
  if (modOut.decision === 'block') {
    await sink.replaceWith(ctx.t('moderation.output_blocked'));
    await sink.abort();
    return;
  }

  // [AUDIT-A4] Split long replies. First chunk commits via sink.
  const parts = splitForTelegram(accumulated, 4000);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (i === 0) {
      await sink.commit(part);
    } else {
      await ctx.reply(part, { reply_parameters: { message_id: msg.message_id } });
    }
  }

  // [AUDIT-X14] Cost tracking for stateless group turns. [AUDIT-P5] No
  // appendMessage. [AUDIT-N3] No voice output in groups.
  if (finalUsage) {
    await ctx.services.cost.trackRequest({
      userId: user.id as never,
      kind: 'text',
      tokensInput: finalUsage.tokensInput,
      tokensOutput: finalUsage.tokensOutput,
    });
  }
});
