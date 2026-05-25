// [AUDIT-X4, X5, X6, X9] MyContext — single shape passed through every
// middleware and composer.
//
// Services land per-week (see TZ §15):
//   Week 2: gonka, conversation, rateLimit, tokenizer, users, i18n
//   Week 3: voice, persona
//   Week 4: document
//   Week 6: moderation, userReports
//   Week 7A: cost

import type { Context, SessionFlavor } from 'grammy';
import type { User } from '../db/schema.js';
import type { ConversationService } from '../services/conversation.js';
import type { DocumentService } from '../services/document.js';
import type { GonkaClient } from '../services/gonka-client.js';
import type { I18nService } from '../services/i18n.js';
import type { PersonaService } from '../services/persona.js';
import type { RateLimiter } from '../services/rate-limiter.js';
import type { UsersService } from '../services/users.js';
import type { VoiceService } from '../services/voice.js';
import type { Logger, Tokenizer } from '../types.js';

// Empty session — we keep session state in the DB, not in grammY's in-memory
// session. Record<string, never> communicates "object with no keys" without
// tripping Biome's `noBannedTypes` rule the way `{}` does.
export type SessionData = Record<string, never>;

/** Languages we ship UX copy for. Resolved from tg user.language_code. */
export type SupportedLang = 'en' | 'ru' | 'es' | 'ar' | 'zh' | 'de';

/**
 * All services made available to composers via ctx.services.
 * Optional fields are populated only once the corresponding week ships.
 */
export interface BotServices {
  gonka: GonkaClient;
  conversation: ConversationService;
  rateLimit: RateLimiter;
  tokenizer: Tokenizer;
  users: UsersService;
  i18n: I18nService;
  persona: PersonaService;
  voice: VoiceService;
  document: DocumentService;
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
