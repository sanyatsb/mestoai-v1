// chat composer — the main text-in-DM handler.
//
// runTextPipeline is the reusable core: voice composer hands a transcribed
// string straight back into it so we don't fork the pipeline.
//
// Streaming UX:
//   - With STREAMING_USE_EDIT=true (default): we send a placeholder and edit
//     it via editMessageText every ~700ms as new chunks arrive. Output
//     moderation runs AFTER the stream completes; if it blocks, we overwrite
//     the message body with t('moderation.output_blocked'). Safe for fast
//     models (Gemini Flash, 1-3 s end-to-end); avoid on slow reasoners.
//   - With STREAMING_USE_EDIT=false: hidden buffer (TypingIndicatorSink),
//     output moderation runs before the user sees anything. Original
//     [AUDIT-C7] behaviour.
//
// Phase timing: every external call is bracketed by `phaseStart()` and its
// duration logged with `phase: <name>` so dashboards can spot slow stages.

import { Composer, InputFile } from 'grammy';
import { env } from '../../config.js';
import type { ChatMessage } from '../../services/conversation.js';
import type { Persona } from '../../services/persona.js';
import {
  type StreamingTextSink,
  createStreamingEditSink,
  createTypingIndicatorSink,
} from '../../services/streaming-sink.js';
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

/** Wall-clock helper for phase timing. */
function phaseStart() {
  return Date.now();
}
function phaseMs(start: number): number {
  return Date.now() - start;
}

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
  const { gonka, rateLimit, conversation, tokenizer, persona, voice, moderation, cost } =
    ctx.services;
  const pipelineStart = Date.now();

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

  // --- input moderation ---
  let phase = phaseStart();
  const modIn = await moderation.checkInput(text, user.id as never, ctx.lang);
  ctx.logger.info(
    {
      phase: 'input_moderation',
      latencyMs: phaseMs(phase),
      decision: modIn.decision,
      flagged: modIn.flagged,
    },
    'phase_timing',
  );
  if (modIn.decision === 'block') {
    await ctx.reply(
      modIn.triggeredCategories.includes('selfHarm')
        ? ctx.t('moderation.self_harm_resources')
        : ctx.t('moderation.input_blocked'),
    );
    return;
  }

  // --- history load + persist user turn ---
  phase = phaseStart();
  const conv = await conversation.getOrCreateActive(user.id as never);
  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'user',
    content: text,
    ...(ctx.message?.message_id !== undefined ? { tgMessageId: ctx.message.message_id } : {}),
  });
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
  ctx.logger.info(
    {
      phase: 'history_load',
      latencyMs: phaseMs(phase),
      convId: conv.id,
      systemTokens,
      historyLen: historyResult.ok ? historyResult.value.length : 0,
    },
    'phase_timing',
  );
  if (!historyResult.ok) {
    // [AUDIT-A5] Document overflow.
    await ctx.reply(ctx.t('error.internal'));
    ctx.logger.error({ err: historyResult.error }, 'context_overflow');
    return;
  }

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyResult.value,
  ];

  // --- LLM streaming ---
  const sink = createSinkForCtx(ctx);
  let accumulated = '';
  let finalUsage: { tokensInput: number; tokensOutput: number; usageDegraded: boolean } | null =
    null;
  phase = phaseStart();
  let firstTokenAtMs: number | null = null;

  try {
    for await (const chunk of gonka.chatStream({ messages: llmMessages })) {
      if (chunk.delta && firstTokenAtMs == null) {
        firstTokenAtMs = phaseMs(phase);
      }
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
          // [AUDIT-L13] usage missing — tiktoken fallback.
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
    ctx.logger.error({ err: e, userId: user.id }, 'llm_stream_failed');
    await ctx.reply(ctx.t('error.service_unavailable'));
    return;
  }
  ctx.logger.info(
    {
      phase: 'llm_stream',
      latencyMs: phaseMs(phase),
      ttftMs: firstTokenAtMs,
      chars: accumulated.length,
      tokensInput: finalUsage?.tokensInput,
      tokensOutput: finalUsage?.tokensOutput,
      usageDegraded: finalUsage?.usageDegraded ?? null,
    },
    'phase_timing',
  );

  if (accumulated.length === 0) {
    await sink.abort();
    ctx.logger.warn({ userId: user.id }, 'llm_returned_empty_response');
    await ctx.reply(ctx.t('error.service_unavailable'));
    return;
  }

  // --- output moderation ---
  phase = phaseStart();
  const modOut = await moderation.checkOutput(accumulated, user.id as never, ctx.lang);
  ctx.logger.info(
    {
      phase: 'output_moderation',
      latencyMs: phaseMs(phase),
      decision: modOut.decision,
      flagged: modOut.flagged,
    },
    'phase_timing',
  );
  if (modOut.decision === 'block') {
    // For the streaming-edit sink the user has already seen partial output;
    // replaceWith() overwrites the message body. For typing-only sink this
    // call is a no-op and the reply below carries the message.
    await sink.replaceWith(ctx.t('moderation.output_blocked'));
    await sink.abort();
    return;
  }

  // --- commit final + spill long replies ---
  phase = phaseStart();
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
  ctx.logger.info(
    { phase: 'commit', latencyMs: phaseMs(phase), parts: parts.length },
    'phase_timing',
  );

  // --- persist assistant turn ---
  phase = phaseStart();
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
  if (finalUsage) {
    await cost.trackRequest({
      userId: user.id as never,
      kind: 'text',
      tokensInput: finalUsage.tokensInput,
      tokensOutput: finalUsage.tokensOutput,
    });
  }
  ctx.logger.info({ phase: 'persist', latencyMs: phaseMs(phase) }, 'phase_timing');

  // --- optional voice output ---
  if (user.voiceOutputEnabled && ctx.chat?.type === 'private' && accumulated.length <= 2000) {
    phase = phaseStart();
    const result = await voice.synthesize(accumulated, ctx.lang);
    ctx.logger.info(
      {
        phase: 'voice_synth',
        latencyMs: phaseMs(phase),
        ok: result.ok,
        bytes: result.ok ? result.value.byteLength : 0,
      },
      'phase_timing',
    );
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

  ctx.logger.info({ phase: 'pipeline_total', latencyMs: phaseMs(pipelineStart) }, 'phase_timing');
}

function createSinkForCtx(ctx: MyContext, replyToMessageId?: number): StreamingTextSink {
  if (env.STREAMING_USE_EDIT) {
    return createStreamingEditSink({
      ctx,
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    });
  }
  return createTypingIndicatorSink({
    ctx,
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  });
}

/** Exported for the group composer to build its own sink with replyToMessageId. */
export { createSinkForCtx };

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
