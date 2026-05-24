// [AUDIT-X4, X5, X6, X9] MyContext — single shape passed through every
// middleware and composer.
//
// Week 1 stub: only logger / traceId / a placeholder `services` namespace.
// Real services are added per-week (see TZ §15):
//   Week 2: gonka, conversation, rateLimit, tokenizer, users
//   Week 3: voice, persona
//   Week 4: document
//   Week 6: moderation, userReports
//   Week 7A: cost
// i18n and `t()` are introduced in Week 2 along with the i18n middleware.

import type { Context, SessionFlavor } from 'grammy';
import type { User } from '../db/schema.js';
import type { Logger } from '../types.js';

// Empty session — we keep session state in the DB, not in grammY's in-memory
// session. Record<string, never> communicates "object with no keys" without
// tripping Biome's `noBannedTypes` rule the way `{}` does.
export type SessionData = Record<string, never>;

/** Languages we ship UX copy for. Resolved from tg user.language_code. */
export type SupportedLang = 'en' | 'ru' | 'es' | 'ar' | 'zh' | 'de';

/**
 * Lazy injection target — every service registered here gets autocompleted
 * inside handlers as `ctx.services.foo`. Week 1 ships nothing concrete yet
 * (placeholders only); each later week fills the corresponding slot.
 *
 * Empty interface is intentional — composers extend it later via module
 * augmentation if needed.
 */
export interface BotServices {
  // Filled in later weeks. Marker prop keeps the interface non-empty so
  // structural type checks behave predictably.
  readonly _placeholder?: never;
}

export interface CustomCtx {
  // Set by authMiddleware (Week 2+). Undefined in Week 1.
  user?: User;

  // Set by i18nMiddleware (Week 2+). Default 'en' in Week 1.
  lang: SupportedLang;

  // [AUDIT-X9] Set by loggingMiddleware.
  logger: Logger;
  traceId: string;

  // Filled lazily as services come online.
  services: BotServices;

  // i18n shortcut — added in Week 2 by i18n middleware.
  // Week 1 fallback returns the key itself.
  t(key: string, params?: Record<string, string | number>): string;
}

export type MyContext = Context & CustomCtx & SessionFlavor<SessionData>;
