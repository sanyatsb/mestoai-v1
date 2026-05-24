// [AUDIT-C1, C7, N2] TypingIndicatorSink.
//
// We stream the model's response into a hidden buffer (the chat shows only
// a "typing…" indicator) and reveal the final text in a single sendMessage
// only after output moderation has cleared it. That closes the race where
// a partial harmful chunk would otherwise be visible to the user before
// moderation could redact it.
//
// In DM: commit() does a plain ctx.reply.
// In a group (replyToMessageId provided): commit() replies to the user's
// original message so the thread context is obvious. [AUDIT-N2]

import type { MyContext } from '../bot/context.js';

export interface StreamingTextSink {
  /** Called for every model chunk. Currently just refreshes the typing-indicator. */
  push(chunk: string): Promise<void>;
  /** Output moderation passed → show finalText. Returns Telegram message_id. */
  commit(finalText: string): Promise<{ tgMessageId: number }>;
  /** Stops the typing-indicator without ever sending the buffered text. */
  abort(): Promise<void>;
}

export interface TypingIndicatorSinkOptions {
  ctx: MyContext;
  /** When set, commit() replies to this Telegram message. [AUDIT-N2] */
  replyToMessageId?: number;
  /** Telegram drops typing after ~5s; refresh a bit faster than that. */
  refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_MS = 4000;

export function createTypingIndicatorSink(opts: TypingIndicatorSinkOptions): StreamingTextSink {
  const { ctx } = opts;
  const refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;

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

  // Kick off immediately, then keep refreshing.
  void sendTyping();
  const interval = setInterval(() => {
    if (stopped) return;
    void sendTyping();
  }, refreshIntervalMs);
  // Don't keep the event loop alive just to refresh typing.
  if (typeof interval.unref === 'function') interval.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };

  return {
    async push(_chunk) {
      // Future: chunked moderation could go here (Phase 1.1). For MVP we
      // just keep the typing indicator alive — refresh on demand if we've
      // gone quiet for a while between chunks.
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
  };
}
