// [AUDIT-L4, L16, X11] i18n service.
//
// JSON locales are loaded synchronously via fs.readFileSync at module init
// instead of `import ... with { type: 'json' }` because the latter triggers
// warnings/errors in some bundlers (vitest/esbuild on the boundary). Both
// approaches are equivalent at runtime; readFileSync just avoids the import
// attribute syntax friction.
//
// Fallback strategy: lang → en → key (with one-time warn per missing key).
// Param substitution is a plain {name} replace — no plurals/ICU in MVP.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupportedLang } from '../bot/context.js';
import type { Logger } from '../types.js';

type Locale = Record<string, string>;

function loadLocale(name: SupportedLang): Locale {
  const url = new URL(`../locales/${name}.json`, import.meta.url);
  const raw = readFileSync(fileURLToPath(url), 'utf8');
  return JSON.parse(raw) as Locale;
}

const LOCALES: Record<SupportedLang, Locale> = {
  en: loadLocale('en'),
  ru: loadLocale('ru'),
  es: loadLocale('es'),
  ar: loadLocale('ar'),
  zh: loadLocale('zh'),
  de: loadLocale('de'),
};

const SUPPORTED: ReadonlySet<SupportedLang> = new Set(['en', 'ru', 'es', 'ar', 'zh', 'de']);

export interface I18nService {
  t(key: string, lang: SupportedLang | string, params?: Record<string, string | number>): string;
  resolveLang(tgLanguageCode: string | undefined): SupportedLang;
}

export function createI18nService(logger: Logger): I18nService {
  // Track keys we've warned about so logs don't explode on every miss.
  const warnedKeys = new Set<string>();

  const warnOnce = (key: string, lang: string): void => {
    const id = `${lang}:${key}`;
    if (warnedKeys.has(id)) return;
    warnedKeys.add(id);
    logger.warn({ key, lang }, 'i18n_key_missing');
  };

  return {
    t(key, lang, params) {
      const resolved = (SUPPORTED as Set<string>).has(lang) ? (lang as SupportedLang) : 'en';
      let value = LOCALES[resolved][key] ?? LOCALES.en[key];
      if (value === undefined) {
        warnOnce(key, resolved);
        value = key;
      }

      if (!params) return value;
      return value.replace(/\{(\w+)\}/g, (_, name: string) => {
        const replacement = params[name];
        return replacement == null ? `{${name}}` : String(replacement);
      });
    },
    resolveLang(tgLanguageCode) {
      if (!tgLanguageCode) return 'en';
      const base = tgLanguageCode.split('-')[0]?.toLowerCase();
      if (base && (SUPPORTED as Set<string>).has(base)) return base as SupportedLang;
      return 'en';
    },
  };
}
