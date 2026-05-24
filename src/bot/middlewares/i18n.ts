// [AUDIT-X10] i18n middleware (Week 1 stub).
//
// Sets ctx.lang to a sensible default and provides a passthrough `t()` that
// returns the key itself. Real localization with JSON locales arrives in
// Week 2 — that version of this middleware will load locales, resolve the
// user's preferred lang, and substitute {params}.

import type { MiddlewareFn } from 'grammy';
import type { MyContext, SupportedLang } from '../context.js';

const SUPPORTED: ReadonlySet<SupportedLang> = new Set(['en', 'ru', 'es', 'ar', 'zh', 'de']);

function resolveLang(tgLang: string | undefined): SupportedLang {
  if (!tgLang) return 'en';
  const base = tgLang.split('-')[0]?.toLowerCase();
  if (base && (SUPPORTED as Set<string>).has(base)) return base as SupportedLang;
  return 'en';
}

export const i18nMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  ctx.lang = resolveLang(ctx.from?.language_code);
  // Week 1 stub: t() returns the key itself (no locales loaded yet).
  ctx.t = (key, params) => {
    if (!params) return key;
    return `${key} ${JSON.stringify(params)}`;
  };
  return next();
};
