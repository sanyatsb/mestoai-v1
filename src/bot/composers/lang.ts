// /lang — let the user pick a different UI language.
//
// The change is persisted on user.language_code so the auth-middleware
// path picks it up on every subsequent update. We don't restart the
// conversation — locale only affects bot copy, not the persona/history.

import { Composer, InlineKeyboard } from 'grammy';
import type { MyContext, SupportedLang } from '../context.js';

export const langComposer = new Composer<MyContext>();

const LANG_CALLBACK_PREFIX = 'lang:';

// User-facing labels for each lang option. Self-named so a Chinese user
// browsing the list still sees "中文" and recognises it.
const LANG_LABELS: Record<SupportedLang, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  ar: 'العربية',
  zh: '中文',
  de: 'Deutsch',
};

langComposer.command('lang', async (ctx) => {
  const kb = new InlineKeyboard();
  const langs = Object.keys(LANG_LABELS) as SupportedLang[];
  langs.forEach((lang, idx) => {
    kb.text(LANG_LABELS[lang], `${LANG_CALLBACK_PREFIX}${lang}`);
    if (idx % 2 === 1) kb.row();
  });
  await ctx.reply(ctx.t('lang.choose'), { reply_markup: kb });
});

langComposer.callbackQuery(new RegExp(`^${LANG_CALLBACK_PREFIX}`), async (ctx) => {
  const user = ctx.user;
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Auth required' });
    return;
  }
  const data = ctx.callbackQuery.data ?? '';
  const lang = data.slice(LANG_CALLBACK_PREFIX.length) as SupportedLang;
  if (!(lang in LANG_LABELS)) {
    await ctx.answerCallbackQuery({ text: 'Unknown lang' });
    return;
  }

  await ctx.services.users.update(user.id, { languageCode: lang });

  // ctx.t still uses the OLD lang for this callback's reply — re-render
  // through the i18n service directly so the confirmation lands in the
  // language the user just picked.
  const confirmation = ctx.services.i18n.t('lang.selected', lang, {
    lang: LANG_LABELS[lang],
  });
  try {
    await ctx.editMessageText(confirmation);
  } catch {
    // edit can fail if the menu is too old; ignore.
  }
  await ctx.answerCallbackQuery();
});
