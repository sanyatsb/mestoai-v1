// [AUDIT-L12, X9, X10] Logging middleware. Runs FIRST so every downstream
// log carries the same traceId.

import type { MiddlewareFn } from 'grammy';
import { createRequestLogger, logger as rootLogger } from '../../utils/logger.js';
import type { MyContext } from '../context.js';

export const loggingMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  const { logger, traceId } = createRequestLogger(rootLogger);
  ctx.logger = logger.child({
    tgUserId: ctx.from?.id,
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
    updateType: ctx.update.message ? 'message' : ctx.update.callback_query ? 'callback' : 'other',
  });
  ctx.traceId = traceId;

  const start = Date.now();
  try {
    await next();
    ctx.logger.info({ durationMs: Date.now() - start }, 'update_processed');
  } catch (e) {
    ctx.logger.error({ err: e, durationMs: Date.now() - start }, 'update_failed');
    throw e;
  }
};
