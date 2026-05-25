// ModerationService — single decision point for input/output safety.
//
// Pipeline (TZ §10):
//   1. BlacklistChecker (instant)
//   2. JailbreakDetector (regex; input only)
//   3. OpenAI Moderation (omni-moderation-latest)
//   4. Map OpenAI categories → internal categories [AUDIT-H12]
//   5. Apply per-internal-category thresholds (from env)
//
// Special paths:
//   - [AUDIT-H11] sexualMinors → instant `bannedPermanent` + admin alert,
//     BEFORE any counter touches. Severity = critical.
//   - [AUDIT-N1, N5] Any other flagged INPUT → atomic
//     usersRepo.incrementFlagCount, which may set 24h bannedUntil or
//     permaban in the same SQL transaction as the increment.
//   - [AUDIT-C7] checkOutput runs AFTER stream completion and BEFORE the
//     buffered text is revealed in chat/group composers, so a flagged
//     output blocks the message without the user ever seeing it.
//   - Output-side sexualMinors does NOT permaban the user (model artefact),
//     but still alerts an admin and blocks the reply.

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { AuditLogRepository } from '../db/repositories/audit-log.js';
import type { UsersRepository } from '../db/repositories/users.js';
import type { Logger, UserId } from '../types.js';
import type { BlacklistChecker } from './blacklist-checker.js';
import type { JailbreakDetector } from './jailbreak-detector.js';

// Minimal bot surface this service needs — keeps it free of the
// `Bot<MyContext>` generic and the circular import on bot/context.js that
// would create.
export interface BotApiHandle {
  api: { sendMessage(chatId: number, text: string): Promise<unknown> };
}

// [AUDIT-H12] OpenAI returns categories with slashes; we collapse synonyms
// onto a smaller internal vocabulary so a single env threshold governs
// each "real" axis we care about.
export const OPENAI_TO_INTERNAL_CATEGORY = {
  sexual: 'sexual',
  'sexual/minors': 'sexualMinors',
  hate: 'hate',
  'hate/threatening': 'hate',
  harassment: 'harm',
  'harassment/threatening': 'harm',
  'self-harm': 'selfHarm',
  'self-harm/intent': 'selfHarm',
  'self-harm/instructions': 'selfHarm',
  violence: 'violence',
  'violence/graphic': 'violence',
} as const;

export type InternalCategory =
  (typeof OPENAI_TO_INTERNAL_CATEGORY)[keyof typeof OPENAI_TO_INTERNAL_CATEGORY];

export interface ModerationThresholds {
  sexualMinors: number;
  harm: number;
  violence: number;
  hate: number;
  selfHarm: number;
  sexual: number;
}

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
  decision: 'allow' | 'block';
  severity: 'low' | 'medium' | 'high' | 'critical';
  triggeredCategories: InternalCategory[];
  /** Set when this call also banned the user. */
  banFired?: 'temporary' | 'permanent';
}

export interface ModerationService {
  checkInput(text: string, userId: UserId, lang: string): Promise<ModerationResult>;
  checkOutput(text: string, userId: UserId, lang: string): Promise<ModerationResult>;
}

export interface ModerationServiceDeps {
  openaiApiKey: string;
  moderationModel: string;
  jailbreak: JailbreakDetector;
  blacklist: BlacklistChecker;
  users: UsersRepository;
  auditLog: AuditLogRepository;
  thresholds: ModerationThresholds;
  banFlagThreshold: number;
  permabanFlagThreshold: number;
  bot: BotApiHandle;
  adminChatId: number;
  logger: Logger;
  /**
   * Master kill-switch for the whole moderation pipeline. When false,
   * checkInput/checkOutput return ALLOW immediately without any HTTP call,
   * blacklist match, or jailbreak detection. Intended for dev/local
   * environments where the OpenAI key is rate-limited; production should
   * keep this true.
   */
  enabled: boolean;
}

export function createModerationService(deps: ModerationServiceDeps): ModerationService {
  if (!deps.enabled) {
    deps.logger.warn('moderation_disabled — every check will return ALLOW');
    const allow = async () => ALLOW;
    return { checkInput: allow, checkOutput: allow };
  }

  const openai = new OpenAI({ apiKey: deps.openaiApiKey });

  return {
    checkInput: (text, userId, lang) => runPipeline('input', text, userId, lang, deps, openai),
    checkOutput: (text, userId, lang) => runPipeline('output', text, userId, lang, deps, openai),
  };
}

// ---- pipeline ----

const ALLOW: ModerationResult = {
  flagged: false,
  categories: {},
  scores: {},
  decision: 'allow',
  severity: 'low',
  triggeredCategories: [],
};

async function runPipeline(
  direction: 'input' | 'output',
  text: string,
  userId: UserId,
  lang: string,
  deps: ModerationServiceDeps,
  openai: OpenAI,
): Promise<ModerationResult> {
  // 1. Blacklist
  const blacklistHit = deps.blacklist.check(text);
  if (blacklistHit) {
    await deps.auditLog.create({
      userId: userId as number,
      eventType: `blacklist_${direction}`,
      severity: 'medium',
      contentHash: sha256(text),
      contentExcerpt: text.slice(0, 200),
      categories: { blacklist: true },
      moderationScores: null,
      metadata: { lang, matched: blacklistHit, direction },
    });
    return { ...ALLOW, flagged: true, decision: 'block', severity: 'medium' };
  }

  // 2. Jailbreak — input only.
  if (direction === 'input') {
    const jb = deps.jailbreak.detect(text);
    if (jb.matched) {
      await deps.auditLog.create({
        userId: userId as number,
        eventType: 'jailbreak_attempt',
        severity: 'high',
        contentHash: sha256(text),
        contentExcerpt: text.slice(0, 200),
        categories: { jailbreak: true },
        moderationScores: null,
        metadata: { lang, pattern: jb.pattern },
      });
      const banFired = await safeIncrement(deps, userId, 'jailbreak_attempt');
      return {
        ...ALLOW,
        flagged: true,
        decision: 'block',
        severity: 'high',
        ...(banFired ? { banFired } : {}),
      };
    }
  }

  // 3. OpenAI Moderation
  let result: Awaited<ReturnType<typeof openai.moderations.create>>['results'][number];
  try {
    const response = await openai.moderations.create({
      model: deps.moderationModel,
      input: text,
    });
    const first = response.results[0];
    if (!first) {
      deps.logger.error('openai_moderation_empty_results');
      return ALLOW;
    }
    result = first;
  } catch (e) {
    // Fail OPEN — don't lock users out on infra blips, but log it loudly.
    deps.logger.warn({ err: e }, 'openai_moderation_failed_fail_open');
    return ALLOW;
  }

  // 4. Map + 5. Thresholds.
  const triggered: InternalCategory[] = [];
  const scores: Record<string, number> = {};
  for (const [openaiCat, raw] of Object.entries(result.category_scores)) {
    const score = typeof raw === 'number' ? raw : 0;
    scores[openaiCat] = score;
    const internal =
      OPENAI_TO_INTERNAL_CATEGORY[openaiCat as keyof typeof OPENAI_TO_INTERNAL_CATEGORY];
    if (!internal) continue;
    if (score >= deps.thresholds[internal] && !triggered.includes(internal)) {
      triggered.push(internal);
    }
  }

  if (triggered.length === 0) return ALLOW;

  const categories = result.categories as unknown as Record<string, boolean>;

  // [AUDIT-H11] sexualMinors — instant permaban on INPUT, blocked-only on OUTPUT.
  if (triggered.includes('sexualMinors')) {
    await deps.auditLog.create({
      userId: userId as number,
      eventType: 'sexual_minors_detected',
      severity: 'critical',
      contentHash: sha256(text),
      contentExcerpt: text.slice(0, 200),
      categories,
      moderationScores: scores,
      metadata: { lang, direction },
    });

    if (direction === 'input') {
      await deps.users.update(userId as number, {
        bannedPermanent: true,
        banReason: 'csam_protection',
      });
      await notifyAdmin(deps, `🚨 CRITICAL: sexual/minors in INPUT, user ${userId} permabanned.`);
      return {
        flagged: true,
        decision: 'block',
        severity: 'critical',
        categories,
        scores,
        triggeredCategories: triggered,
        banFired: 'permanent',
      };
    }
    await notifyAdmin(
      deps,
      `🚨 CRITICAL: sexual/minors in OUTPUT for user ${userId} — model response blocked.`,
    );
    return {
      flagged: true,
      decision: 'block',
      severity: 'critical',
      categories,
      scores,
      triggeredCategories: triggered,
    };
  }

  // Regular flagged path.
  const severity: ModerationResult['severity'] = triggered.some(
    (c) => c === 'selfHarm' || c === 'violence' || c === 'hate',
  )
    ? 'high'
    : 'medium';

  await deps.auditLog.create({
    userId: userId as number,
    eventType: `flag_${direction}`,
    severity,
    contentHash: sha256(text),
    contentExcerpt: text.slice(0, 200),
    categories,
    moderationScores: scores,
    metadata: { lang, direction, triggered },
  });

  const banFired =
    direction === 'input' ? await safeIncrement(deps, userId, `flag_${direction}`) : undefined;

  return {
    flagged: true,
    decision: 'block',
    severity,
    categories,
    scores,
    triggeredCategories: triggered,
    ...(banFired ? { banFired } : {}),
  };
}

async function safeIncrement(
  deps: ModerationServiceDeps,
  userId: UserId,
  reason: string,
): Promise<'temporary' | 'permanent' | undefined> {
  try {
    const r = await deps.users.incrementFlagCount(userId as number, {
      banThreshold: deps.banFlagThreshold,
      permabanThreshold: deps.permabanFlagThreshold,
      banReason: reason,
    });
    if (r.permabannedThisCall) {
      await notifyAdmin(
        deps,
        `🚨 Permaban: user ${userId} reached ${r.flagCountTotal} total flags (reason: ${reason}).`,
      );
      return 'permanent';
    }
    if (r.bannedThisCall) {
      await notifyAdmin(
        deps,
        `⚠️ 24h ban: user ${userId} reached ${r.flagCountWeek} flags this week (reason: ${reason}).`,
      );
      return 'temporary';
    }
    return undefined;
  } catch (e) {
    deps.logger.error({ err: e, userId }, 'flag_count_increment_failed');
    return undefined;
  }
}

async function notifyAdmin(deps: ModerationServiceDeps, text: string): Promise<void> {
  try {
    await deps.bot.api.sendMessage(deps.adminChatId, text);
  } catch (e) {
    deps.logger.warn({ err: e }, 'admin_notify_failed');
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
