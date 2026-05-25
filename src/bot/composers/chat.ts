// chat composer — the main text-in-DM handler.
//
// runTextPipeline is the reusable core: voice composer hands a transcribed
// string straight back into it so we don't fork the pipeline.
//
// Week 3 additions vs Week 2:
//   - PersonaService renders the system prompt (with ALWAYS respond in:
//     [AUDIT-L14]) and the active persona is loaded from the DB row.
//   - Voice output (Edge-TTS) when user.voiceOutputEnabled is on and we're
//     in a private chat [AUDIT-N3]. TTS failures are non-fatal — text reply
//     still goes out.
//
// Week 6 will add input/output moderation; Week 7A wires cost-tracker.

import { Composer, InputFile } from 'grammy';
import { env } from '../../config.js';
import type { ChatMessage } from '../../services/conversation.js';
import type { Persona } from '../../services/persona.js';
import { createTypingIndicatorSink } from '../../services/streaming-sink.js';
import { toPersonaId } from '../../utils/ids.js';
import { splitForTelegram } from '../../utils/telegram-split.js';
import type { MyContext } from '../context.js';

export const chatComposer = new Composer<MyContext>();

// Catch plain text messages in private chats. Commands are routed by their
// own composers above this one (grammY dispatches in registration order).
chatComposer.chatType('private').on('message:text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/')) {
    // Commands have their own composers; defer.
    return next();
  }
  await runTextPipeline(ctx, ctx.message.text);
});

/**
 * Shared text pipeline. Used directly for text messages and by voice
 * composer after transcription.
 */
export async function runTextPipeline(ctx: MyContext, text: string): Promise<void> {
  const user = ctx.user;
  if (!user) {
    ctx.logger.error('chat_handler_without_user');
    return;
  }
  const { gonka, rateLimit, conversation, tokenizer, persona, voice, moderation } = ctx.services;

  // [AUDIT-H4] counter increments even on reject — that's the design.
  const rl = await rateLimit.checkAndIncrement(user.id as never, 'text');
  if (!rl.allowed) {
    await ctx.reply(
      ctx.t('rate_limit.text', {
        current: rl.current,
        limit: rl.limit,
        hours: Math.ceil(rl.resetsInSec / 3600),
      }),
    );
    return;
  }

  if (text.length > env.MAX_MESSAGE_LENGTH_CHARS) {
    await ctx.reply(ctx.t('error.message_too_long', { limit: env.MAX_MESSAGE_LENGTH_CHARS }));
    return;
  }

  // [AUDIT-C7] Input moderation BEFORE we touch Kimi / store the message.
  // If banFired we don't need a separate message — the auth middleware
  // already blocks the next update from a banned user.
  const modIn = await moderation.checkInput(text, user.id as never, ctx.lang);
  if (modIn.decision === 'block') {
    await ctx.reply(
      modIn.triggeredCategories.includes('selfHarm')
        ? ctx.t('moderation.self_harm_resources')
        : ctx.t('moderation.input_blocked'),
    );
    return;
  }

  const conv = await conversation.getOrCreateActive(user.id as never);

  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'user',
    content: text,
    ...(ctx.message?.message_id !== undefined ? { tgMessageId: ctx.message.message_id } : {}),
  });

  // Resolve active persona: conversation override → user default → DB default.
  const activePersona = await resolveActivePersona(ctx, conv.personaId, user.activePersonaId);

  const systemPrompt = persona.renderSystemPrompt({
    persona: activePersona,
    userLang: ctx.lang,
    ...(conv.documentText ? { documentText: conv.documentText } : {}),
    ...(conv.documentName ? { documentName: conv.documentName } : {}),
  });
  const systemTokens = tokenizer.estimate(systemPrompt);

  const historyResult = await conversation.getMessagesForLlm({
    conversationId: conv.id,
    reservedForSystem: systemTokens,
  });
  if (!historyResult.ok) {
    // [AUDIT-A5] Document overflow — possible from Week 4 onward.
    await ctx.reply(ctx.t('error.internal'));
    ctx.logger.error({ err: historyResult.error }, 'context_overflow');
    return;
  }

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyResult.value,
  ];

  // [AUDIT-C7] Stream into hidden sink so output moderation (Week 6) can
  // veto the response before the user sees a single character.
  const sink = createTypingIndicatorSink({ ctx });
  let accumulated = '';
  let finalUsage: { tokensInput: number; tokensOutput: number; usageDegraded: boolean } | null =
    null;

  try {
    for await (const chunk of gonka.chatStream({ messages: llmMessages })) {
      accumulated += chunk.delta;
      if (chunk.delta) await sink.push(chunk.delta);
      if (chunk.done) {
        if (chunk.tokensInput != null && chunk.tokensOutput != null) {
          finalUsage = {
            tokensInput: chunk.tokensInput,
            tokensOutput: chunk.tokensOutput,
            usageDegraded: false,
          };
        } else {
          // [AUDIT-L13] Fallback: estimate via tiktoken and flag the metric.
          ctx.logger.warn({ userId: user.id }, 'gateway_usage_missing_falling_back');
          finalUsage = {
            tokensInput: tokenizer.estimate(JSON.stringify(llmMessages)),
            tokensOutput: tokenizer.estimate(accumulated),
            usageDegraded: true,
          };
        }
      }
    }
  } catch (e) {
    await sink.abort();
    ctx.logger.error({ err: e, userId: user.id }, 'gonka_stream_failed');
    await ctx.reply(ctx.t('error.service_unavailable'));
    return;
  }

  if (accumulated.length === 0) {
    await sink.abort();
    ctx.logger.warn({ userId: user.id }, 'gonka_returned_empty_response');
    await ctx.reply(ctx.t('error.service_unavailable'));
    return;
  }

  // [AUDIT-C7] Output moderation BEFORE revealing the buffered text. The
  // sink has been streaming a typing-indicator only — abort() leaves no
  // visible bot message.
  const modOut = await moderation.checkOutput(accumulated, user.id as never, ctx.lang);
  if (modOut.decision === 'block') {
    await sink.abort();
    await ctx.reply(ctx.t('moderation.output_blocked'));
    return;
  }

  // [AUDIT-A4] Telegram caps messages at 4096 chars.
  const parts = splitForTelegram(accumulated, 4000);
  let firstTgMessageId: number | null = null;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (i === 0) {
      const { tgMessageId } = await sink.commit(part);
      firstTgMessageId = tgMessageId;
    } else {
      const sent = await ctx.reply(part);
      firstTgMessageId ??= sent.message_id;
    }
  }

  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: accumulated,
    ...(firstTgMessageId !== null ? { tgMessageId: firstTgMessageId } : {}),
    ...(finalUsage ? { tokensInput: finalUsage.tokensInput } : {}),
    ...(finalUsage ? { tokensOutput: finalUsage.tokensOutput } : {}),
    costUsd: finalUsage
      ? finalUsage.tokensInput * env.COST_PER_INPUT_TOKEN_USD +
        finalUsage.tokensOutput * env.COST_PER_OUTPUT_TOKEN_USD
      : null,
  });

  // [AUDIT-N3] Voice output ONLY in private DMs, never groups. Also cap on
  // length — TTS for 4K-char essays is wasteful and Telegram has its own
  // duration limits.
  if (user.voiceOutputEnabled && ctx.chat?.type === 'private' && accumulated.length <= 2000) {
    const result = await voice.synthesize(accumulated, ctx.lang);
    if (result.ok) {
      try {
        await ctx.replyWithVoice(new InputFile(result.value, 'response.ogg'));
      } catch (e) {
        ctx.logger.warn({ err: e }, 'voice_reply_failed');
      }
    } else {
      ctx.logger.warn({ err: result.error }, 'tts_failed_non_fatal');
    }
  }
}

/**
 * Resolve which persona is active for this turn. Precedence:
 *   1. The conversation's own personaId (set when /persona started it).
 *   2. The user's activePersonaId.
 *   3. The DB default persona.
 */
async function resolveActivePersona(
  ctx: MyContext,
  convPersonaId: number | null,
  userPersonaId: number | null,
): Promise<Persona> {
  const candidate = convPersonaId ?? userPersonaId;
  if (candidate != null) {
    const p = await ctx.services.persona.getById(toPersonaId(candidate));
    if (p) return p;
    ctx.logger.warn({ candidate }, 'active_persona_missing_falling_back_to_default');
  }
  return ctx.services.persona.getDefault();
}
