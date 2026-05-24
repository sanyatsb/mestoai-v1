// chat composer — the main text-in-DM handler.
//
// Week 2 scope: rate-limit → length check → conversation + Kimi via Gonka,
// streamed into a hidden typing-indicator → reveal final text only after
// the stream completes [AUDIT-C7] → persist + (later) cost tracking.
//
// Week 3 adds voice output and persona-rendered system prompts.
// Week 4 adds attached-document handling (already supported by
// ConversationService but no documents are attached yet in MVP code paths
// before Week 4).
// Week 6 adds input/output moderation and rolls in the audit log.

import { Composer } from 'grammy';
import { env } from '../../config.js';
import type { ChatMessage } from '../../services/conversation.js';
import { createTypingIndicatorSink } from '../../services/streaming-sink.js';
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
  await handleTextMessage(ctx);
});

async function handleTextMessage(ctx: MyContext): Promise<void> {
  const user = ctx.user;
  if (!user) {
    ctx.logger.error('chat_handler_without_user');
    return;
  }
  const text = ctx.message?.text ?? '';
  const { gonka, rateLimit, conversation, tokenizer } = ctx.services;

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

  // Week 6 will add input moderation here, before we touch the LLM.

  const conv = await conversation.getOrCreateActive(user.id as never);

  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'user',
    content: text,
    ...(ctx.message?.message_id !== undefined ? { tgMessageId: ctx.message.message_id } : {}),
  });

  // Week 2 system prompt is intentionally generic — PersonaService lands
  // in Week 3 along with renderSystemPrompt().
  const systemPrompt = buildWeek2SystemPrompt(ctx.lang);
  const systemTokens = tokenizer.estimate(systemPrompt);

  const historyResult = await conversation.getMessagesForLlm({
    conversationId: conv.id,
    reservedForSystem: systemTokens,
  });
  if (!historyResult.ok) {
    // [AUDIT-A5] Document overflow — but Week 2 has no documents, so this
    // path is purely defensive.
    await ctx.reply(ctx.t('error.internal'));
    ctx.logger.error({ err: historyResult.error }, 'context_overflow_unexpected_in_week2');
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
          // [AUDIT-L13] Fallback: estimate via tiktoken and flag the metric
          // so dashboards can highlight degraded cost accuracy.
          ctx.logger.warn({ userId: user.id }, 'gateway_usage_missing_falling_back_to_tiktoken');
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

  // Week 6: output moderation goes RIGHT HERE — before sink.commit.

  // [AUDIT-A4] Telegram caps messages at 4096 chars — split on natural
  // breaks. First part replaces the typing indicator; the rest are sent as
  // follow-up replies.
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

  // Cost tracking lands in Week 7A — for now the per-message costUsd column
  // already captures the spend.
}

/**
 * Week 2 placeholder system prompt. Week 3's PersonaService replaces this
 * with the active persona's prompt + [AUDIT-L14] explicit language pinning.
 */
function buildWeek2SystemPrompt(userLang: string): string {
  return [
    'You are a helpful, friendly AI assistant powered by Kimi K2.6 on the Gonka decentralized network.',
    'Be concise but complete. Avoid disclaimers unless safety-relevant.',
    'Refuse harmful, illegal, or unethical requests politely.',
    `\nALWAYS respond in: ${userLang}`,
  ].join(' ');
}
