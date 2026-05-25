// Sanity checks for the real i18n service backed by the actual locale
// files. We're not testing every key — just the fallback chain and param
// substitution, which is where bugs hide.

import { describe, expect, it, vi } from 'vitest';
import { createI18nService } from '../../../src/services/i18n.js';

const silentLogger = {
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: vi.fn(),
  error: () => undefined,
  fatal: () => undefined,
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino-like stub
} as any;

describe('I18nService', () => {
  it('returns the localized string for a known key + lang', () => {
    const i18n = createI18nService(silentLogger);
    const en = i18n.t('persona.choose', 'en');
    const ru = i18n.t('persona.choose', 'ru');
    expect(en).toMatch(/persona/i);
    // Russian translation should differ from English copy
    expect(ru).not.toBe(en);
    expect(ru).toContain('персонажа');
  });

  it('substitutes {params} via simple replace', () => {
    const i18n = createI18nService(silentLogger);
    const out = i18n.t('rate_limit.text', 'en', { current: 31, limit: 30, hours: 12 });
    expect(out).toContain('31');
    expect(out).toContain('30');
    expect(out).toContain('12');
  });

  it('falls back to English when the key is missing in the chosen lang', () => {
    const i18n = createI18nService(silentLogger);
    // 'help.text' exists in en; suppose we asked for an unsupported lang
    // (resolved to 'en' anyway), or we asked for de but the key really only
    // existed in en. Either way the user gets English copy, not the bare key.
    const out = i18n.t('help.text', 'de');
    expect(out).toMatch(/start|persona/i);
  });

  it('returns the raw key and warns once when the key is missing everywhere', () => {
    silentLogger.warn.mockClear();
    const i18n = createI18nService(silentLogger);
    const a = i18n.t('totally.unknown.key', 'en');
    const b = i18n.t('totally.unknown.key', 'en');
    expect(a).toBe('totally.unknown.key');
    expect(b).toBe('totally.unknown.key');
    // warn-once: should fire on first miss, not the second.
    expect(silentLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('resolveLang maps tg language_code → SupportedLang with safe fallback', () => {
    const i18n = createI18nService(silentLogger);
    expect(i18n.resolveLang('ru')).toBe('ru');
    expect(i18n.resolveLang('en-US')).toBe('en');
    expect(i18n.resolveLang('pt-BR')).toBe('en');
    expect(i18n.resolveLang(undefined)).toBe('en');
  });
});
