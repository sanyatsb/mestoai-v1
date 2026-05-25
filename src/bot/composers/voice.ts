// voice composer — /voice toggle + handler for incoming voice/audio messages.
//
// Flow for an incoming voice message:
//   1. Size guard ([AUDIT-M12]).
//   2. Rate-limit increment (`voice` bucket). Counter sticks even when
//      Whisper fails — defense against spammy /voice retries
//      ([AUDIT-H7]).
//   3. Download .ogg from Telegram, run Whisper.
//   4. Echo the transcription back to the user as confirmation.
//   5. Hand off to the standard text pipeline by injecting the
//      transcription back through the chat handler.
//
// The text pipeline itself (typing-indicator → Kimi → split → persist) lives
// in composers/chat.ts and is re-exported here as runTextPipeline so we don't
// duplicate it.

import { Composer } from 'grammy';
import { env } from '../../config.js';
import type { MyContext } from '../context.js';
import { runTextPipeline } from './chat.js';

export const voiceComposer = new Composer<MyContext>();

// ---- /voice toggle ----

voiceComposer.command('voice', async (ctx) => {
  const user = ctx.user;
  if (!user) return;
  const next = !user.voiceOutputEnabled;
  await ctx.services.users.update(user.id, { voiceOutputEnabled: next });
  await ctx.reply(ctx.t(next ? 'voice.enabled' : 'voice.disabled'));
});

// ---- incoming voice / audio in DM ----

voiceComposer.chatType('private').on(['message:voice', 'message:audio'], async (ctx) => {
  const user = ctx.user;
  if (!user) return;

  const media = ctx.message?.voice ?? ctx.message?.audio;
  if (!media) return;

  // [AUDIT-M12] reject too-large audio before paying for the round-trip.
  if (media.file_size && media.file_size > env.MAX_VOICE_SIZE_MB * 1024 * 1024) {
    await ctx.reply(ctx.t('voice.too_large', { limit: env.MAX_VOICE_SIZE_MB }));
    return;
  }

  // [AUDIT-H4, H7] Rate-limit BEFORE the Whisper call; counter increments
  // even if the call fails. That's intentional anti-spam.
  const rl = await ctx.services.rateLimit.checkAndIncrement(user.id as never, 'voice');
  if (!rl.allowed) {
    await ctx.reply(
      ctx.t('rate_limit.voice', {
        hours: Math.ceil(rl.resetsInSec / 3600),
      }),
    );
    return;
  }

  // Download the Telegram file.
  const tgFile = await ctx.getFile();
  if (!tgFile.file_path) {
    ctx.logger.error('voice_file_path_missing');
    await ctx.reply(ctx.t('error.voice_failed'));
    return;
  }
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${tgFile.file_path}`;
  let audioBytes: Uint8Array;
  try {
    const r = await fetch(fileUrl);
    if (!r.ok) throw new Error(`tg_file_${r.status}`);
    audioBytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    ctx.logger.warn({ err: e }, 'voice_download_failed');
    await ctx.reply(ctx.t('error.voice_failed'));
    return;
  }

  const transcribed = await ctx.services.voice.transcribe(audioBytes, ctx.lang);
  if (!transcribed.ok) {
    await ctx.reply(ctx.t('error.voice_failed'));
    return;
  }

  // [AUDIT-X14] Count the voice message itself in usage stats. The text
  // turn that follows is tracked separately inside runTextPipeline.
  await ctx.services.cost.trackRequest({
    userId: user.id as never,
    kind: 'voice',
    tokensInput: 0,
    tokensOutput: 0,
  });

  // Echo back so the user can confirm Whisper heard them correctly.
  await ctx.reply(`📝 ${transcribed.value}`, {
    reply_parameters: { message_id: ctx.message?.message_id ?? 0 },
  });

  // Drop into the standard text pipeline.
  await runTextPipeline(ctx, transcribed.value);
});
