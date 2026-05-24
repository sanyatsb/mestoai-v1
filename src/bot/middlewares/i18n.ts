// [AUDIT-X10] i18n middleware. Runs after services-injector so it can pull
// the real I18nService out of ctx.services.

import type { MiddlewareFn } from 'grammy';
import type { MyContext } from '../context.js';

export const i18nMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  const i18n = ctx.services.i18n;
  ctx.lang = i18n.resolveLang(ctx.from?.language_code);
  ctx.t = (key, params) => i18n.t(key, ctx.lang, params);
  return next();
};
