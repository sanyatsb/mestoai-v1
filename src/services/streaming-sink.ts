// [AUDIT-C1, C7, N2] Streaming sinks for chat replies.
//
// Two implementations, picked at composer time:
//
//   1. TypingIndicatorSink — stream into hidden buffer, send only after
//      output moderation passes. Original [AUDIT-C7] safe path.
//
//   2. StreamingEditSink — send a placeholder message immediately, then
//      edit it via editMessageText every ~700ms as new chunks arrive.
//      Trades safety for UX speed: the user CAN see flagged content for
//      ~1 second before output moderation runs and overwrites the
//      message body with t('moderation.output_blocked'). For free Gemini
//      Flash (1-3s end-to-end) this window is small; for Kimi (30-150s)
//      it would be unsafe.
//
// In group chats both sinks reply to the user's original message via
// `replyToMessageId`. [AUDIT-N2]

import type { MyContext } from '../bot/context.js';

export interface StreamingTextSink {
  /** Called for every model chunk. */
  push(chunk: string): Promise<void>;
  /** Output moderation passed → reveal/finalize the text. Returns tg message_id. */
  commit(finalText: string): Promise<{ tgMessageId: number }>;
  /** Output moderation failed OR exception → replace/stop without revealing. */
  abort(): Promise<void>;
  /**
   * Replace whatever the user currently sees with the given text. Used by
   * the chat composer to overwrite a partially-streamed reply with
   * t('moderation.output_blocked') if [AUDIT-C7] hits AFTER we already
   * showed some content. No-op for the typing-only sink.
   */
  replaceWith(text: string): Promise<void>;
}

export interface SinkOptions {
  ctx: MyContext;
  /** When set, the first message is sent as a reply to this Telegram message id. */
  replyToMessageId?: number;
}

// ===== TypingIndicatorSink ====================================================

export interface TypingIndicatorSinkOptions extends SinkOptions {
  refreshIntervalMs?: number;
}

const DEFAULT_TYPING_REFRESH_MS = 4000;

/**
 * Hidden-buffer streaming. User sees only a "typing…" indicator until
 * commit(). Used when output moderation MUST run before any chunk is
 * visible (i.e. with slow models where the buffered window is large).
 */
export function createTypingIndicatorSink(opts: TypingIndicatorSinkOptions): StreamingTextSink {
  const { ctx } = opts;
  const refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_TYPING_REFRESH_MS;
  let stopped = false;
  let lastSent = 0;

  const sendTyping = async (): Promise<void> => {
    if (stopped) return;
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    try {
      await ctx.api.sendChatAction(chatId, 'typing');
      lastSent = Date.now();
    } catch (e) {
      ctx.logger.warn({ err: e }, 'typing_action_failed');
    }
  };

  void sendTyping();
  const interval = setInterval(() => {
    if (stopped) return;
    void sendTyping();
  }, refreshIntervalMs);
  if (typeof interval.unref === 'function') interval.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };

  return {
    async push(_chunk) {
      if (Date.now() - lastSent > refreshIntervalMs / 2) {
        await sendTyping();
      }
    },
    async commit(finalText) {
      stop();
      const replyOpts =
        opts.replyToMessageId != null
          ? { reply_parameters: { message_id: opts.replyToMessageId } }
          : undefined;
      const sent = replyOpts ? await ctx.reply(finalText, replyOpts) : await ctx.reply(finalText);
      return { tgMessageId: sent.message_id };
    },
    async abort() {
      stop();
    },
    async replaceWith(_text) {
      // No-op — TypingIndicatorSink never showed text in the first place.
    },
  };
}

// ===== StreamingEditSink ======================================================

export interface StreamingEditSinkOptions extends SinkOptions {
  /** Minimum gap between editMessageText calls (Telegram global edit rate is ~30/sec). Default 700. */
  throttleMs?: number;
  /** First chunk size to send before throttling kicks in. Default 1. */
  initialBurstChars?: number;
  /** Placeholder text shown before the first chunk arrives. Default "…". */
  placeholder?: string;
}

const DEFAULT_THROTTLE_MS = 700;
const DEFAULT_PLACEHOLDER = '…';

/**
 * Real-time streaming via editMessageText. Sends a placeholder immediately,
 * then edits it as new chunks arrive — throttled to avoid hitting the
 * Telegram edit rate limit (~30 req/sec global).
 *
 * push() accumulates the chunk and schedules an edit (or coalesces with a
 * pending one). commit() does one final edit with the canonical text.
 * abort() leaves whatever was last sent — the chat composer is expected to
 * call replaceWith(t('moderation.output_blocked')) immediately after to
 * overwrite the body.
 */
export function createStreamingEditSink(opts: StreamingEditSinkOptions): StreamingTextSink {
  const { ctx } = opts;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const placeholder = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  const replyOpts =
    opts.replyToMessageId != null
      ? { reply_parameters: { message_id: opts.replyToMessageId } }
      : undefined;

  let accumulated = '';
  let lastShown = ''; // last text actually pushed to Telegram (to skip no-op edits)
  let messageId: number | null = null;
  let lastEditAt = 0;
  let editPending = false;
  let stopped = false;

  const ensureMessage = async (): Promise<number> => {
    if (messageId != null) return messageId;
    const sent = replyOpts ? await ctx.reply(placeholder, replyOpts) : await ctx.reply(placeholder);
    messageId = sent.message_id;
    lastShown = placeholder;
    lastEditAt = Date.now();
    return messageId;
  };

  const editNow = async (text: string): Promise<void> => {
    if (stopped) return;
    if (messageId == null) return;
    if (text === lastShown) return;
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    // Telegram caps a single message at 4096; clip mid-stream and let the
    // composer handle the rest at commit time via splitForTelegram.
    const clipped = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    try {
      await ctx.api.editMessageText(chatId, messageId, clipped);
      lastShown = clipped;
      lastEditAt = Date.now();
    } catch (e) {
      // 400 "message is not modified" / "message to edit not found" /
      // 429 "Too Many Requests" — log and ignore. Next push will retry.
      ctx.logger.debug({ err: e }, 'stream_edit_skipped');
    }
  };

  const maybeEdit = async (): Promise<void> => {
    if (stopped || editPending) return;
    const sinceLast = Date.now() - lastEditAt;
    if (sinceLast >= throttleMs) {
      await editNow(accumulated);
      return;
    }
    // Schedule a single trailing edit once the throttle window closes. push()
    // calls during the wait window all coalesce into this one.
    editPending = true;
    setTimeout(() => {
      editPending = false;
      void editNow(accumulated);
    }, throttleMs - sinceLast).unref?.();
  };

  return {
    async push(chunk) {
      if (stopped || !chunk) return;
      accumulated += chunk;
      if (messageId == null) {
        await ensureMessage();
      }
      await maybeEdit();
    },
    async commit(finalText) {
      stopped = false; // commit is allowed even if push() saw no chunks
      const id = await ensureMessage();
      // Final edit — always synchronous, no throttle.
      const clipped = finalText.length > 4000 ? `${finalText.slice(0, 4000)}…` : finalText;
      if (clipped !== lastShown) {
        const chatId = ctx.chat?.id;
        if (chatId != null) {
          try {
            await ctx.api.editMessageText(chatId, id, clipped);
            lastShown = clipped;
          } catch (e) {
            ctx.logger.warn({ err: e }, 'stream_commit_edit_failed');
          }
        }
      }
      stopped = true;
      return { tgMessageId: id };
    },
    async abort() {
      stopped = true;
    },
    async replaceWith(text) {
      const id = await ensureMessage();
      const chatId = ctx.chat?.id;
      if (chatId == null) return;
      try {
        await ctx.api.editMessageText(chatId, id, text);
        lastShown = text;
      } catch (e) {
        ctx.logger.warn({ err: e }, 'stream_replace_failed');
      }
    },
  };
}
