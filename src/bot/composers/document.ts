// document composer — handle PDF / DOCX / TXT uploads in DM.
//
// Flow (TZ §8.4):
//   1. Rate-limit ('document' bucket).
//   2. Size + mime guards.
//   3. Download the Telegram file.
//   4. DocumentService.extractText.
//   5. tokensEstimate vs env.DOCUMENT_MAX_TOKENS.
//   6. (Week 6) Moderate the first 50K chars (AUDIT-M10).
//   7. startNew conversation [AUDIT-C8, N4] — attaching a document always
//      replaces the active context. attachDocument writes the text/name/tokens
//      onto the new conversation row so chat.ts injects it into the system
//      prompt next turn.
//   8. Acknowledge with t('document.replaced_context').

import { Composer } from 'grammy';
import { env } from '../../config.js';
import { SUPPORTED_MIME_TYPES } from '../../services/document.js';
import type { MyContext } from '../context.js';

export const documentComposer = new Composer<MyContext>();

documentComposer.chatType('private').on('message:document', async (ctx) => {
  const user = ctx.user;
  if (!user) return;

  if (!env.FEATURE_DOCUMENTS) {
    await ctx.reply(ctx.t('error.maintenance'));
    return;
  }

  const doc = ctx.message?.document;
  if (!doc) return;

  // [AUDIT-H4] counter increments even on reject — anti-spam.
  const rl = await ctx.services.rateLimit.checkAndIncrement(user.id as never, 'document');
  if (!rl.allowed) {
    await ctx.reply(
      ctx.t('rate_limit.document', {
        hours: Math.ceil(rl.resetsInSec / 3600),
      }),
    );
    return;
  }

  // Size guard before paying for download.
  if (doc.file_size && doc.file_size > env.MAX_DOCUMENT_SIZE_MB * 1024 * 1024) {
    await ctx.reply(ctx.t('document.too_large', { limit: env.MAX_DOCUMENT_SIZE_MB }));
    return;
  }

  // Mime guard. Telegram fills mime_type for nearly all uploads; treat
  // missing mime as unsupported.
  const mime = doc.mime_type ?? '';
  if (!(SUPPORTED_MIME_TYPES as readonly string[]).includes(mime)) {
    await ctx.reply(ctx.t('document.unsupported'));
    return;
  }

  // Download from Telegram.
  const tgFile = await ctx.getFile();
  if (!tgFile.file_path) {
    ctx.logger.error('document_file_path_missing');
    await ctx.reply(ctx.t('document.parse_failed'));
    return;
  }
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${tgFile.file_path}`;
  let bytes: Uint8Array;
  try {
    const r = await fetch(fileUrl);
    if (!r.ok) throw new Error(`tg_file_${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    ctx.logger.warn({ err: e }, 'document_download_failed');
    await ctx.reply(ctx.t('document.parse_failed'));
    return;
  }

  const extracted = await ctx.services.document.extractText({
    fileBytes: bytes,
    mimeType: mime,
    maxSizeMb: env.MAX_DOCUMENT_SIZE_MB,
  });
  if (!extracted.ok) {
    // Localized message per error kind.
    const key = `document.${extracted.error.kind}`;
    const params: Record<string, string | number> = {};
    switch (extracted.error.kind) {
      case 'too_large':
        params.limit = env.MAX_DOCUMENT_SIZE_MB;
        break;
      case 'too_long':
        params.limit = env.DOCUMENT_MAX_TOKENS;
        break;
      default:
        break;
    }
    await ctx.reply(ctx.t(key, params));
    return;
  }

  const { text, pages, tokensEstimate } = extracted.value;
  if (tokensEstimate > env.DOCUMENT_MAX_TOKENS) {
    await ctx.reply(
      ctx.t('document.too_long', {
        tokens: tokensEstimate,
        limit: env.DOCUMENT_MAX_TOKENS,
      }),
    );
    return;
  }

  // [AUDIT-M10] Week 6 will moderate the first 50K chars right here.

  // [AUDIT-C8, N4] Uploading a doc always starts a fresh conversation. The
  // transactional startNew protects the partial unique index even if the
  // user has another message in flight.
  const conv = await ctx.services.conversation.startNew(user.id as never, {
    ...(user.activePersonaId != null ? { personaId: user.activePersonaId as never } : {}),
  });
  await ctx.services.conversation.attachDocument({
    conversationId: conv.id,
    text,
    documentName: doc.file_name ?? 'document',
    tokens: tokensEstimate,
  });
  await ctx.services.users.update(user.id, { activeConversationId: conv.id as number });

  await ctx.reply(
    ctx.t('document.replaced_context', {
      pages,
      tokens: tokensEstimate,
    }),
  );
});
