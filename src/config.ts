// Centralized env validation via zod. Fail loudly at startup if anything is
// missing or malformed — no silent fallbacks.
//
// [AUDIT-C4] CRITICAL SECURITY FIX: zod's built-in z.coerce.boolean() returns
// `true` for any non-empty string — including "false" and "0". This would
// quietly turn KILL_SWITCH=false into KILL_SWITCH=true on every deploy. We
// use a strict enum-based parser instead.
//
// [AUDIT-C5] ADMIN_TG_IDS is transformed to a number[] with filtering of
// invalid values, then refined to require >= 1 admin.

import { z } from 'zod';
import 'dotenv/config';

// [AUDIT-C4] Strict boolean parser. ONLY these values are accepted.
const boolFromEnv = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  // Telegram
  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  WEBHOOK_URL: z.string().url(),
  WEBHOOK_SECRET: z.string().min(16),
  WEBHOOK_PATH: z.string().default('/webhook'),

  // LLM gateway — OpenAI-compatible (OpenRouter / Gonka / OpenAI direct etc).
  LLM_GATEWAY_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('google/gemini-2.0-flash-exp:free'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODERATION_MODEL: z.string().default('omni-moderation-latest'),
  OPENAI_WHISPER_MODEL: z.string().default('whisper-1'),

  // Storage
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Rate limits
  RATE_LIMIT_TEXT_PER_DAY: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_VOICE_PER_DAY: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_DOCUMENT_PER_DAY: z.coerce.number().int().positive().default(3),
  MAX_DOCUMENT_SIZE_MB: z.coerce.number().int().positive().default(10),
  MAX_VOICE_SIZE_MB: z.coerce.number().int().positive().default(25),
  MAX_MESSAGE_LENGTH_CHARS: z.coerce.number().int().positive().default(8000),

  // Cost controls
  DAILY_BUDGET_USD: z.coerce.number().positive().default(50),
  COST_ALERT_THRESHOLD_USD: z.coerce.number().positive().default(30),
  COST_PER_INPUT_TOKEN_USD: z.coerce.number().positive(),
  COST_PER_OUTPUT_TOKEN_USD: z.coerce.number().positive(),

  // Moderation thresholds (internal names — see services/moderation.ts mapping)
  MOD_THRESHOLD_SEXUAL_MINORS: z.coerce.number().min(0).max(1).default(0.2),
  MOD_THRESHOLD_HARM: z.coerce.number().min(0).max(1).default(0.6),
  MOD_THRESHOLD_VIOLENCE: z.coerce.number().min(0).max(1).default(0.7),
  MOD_THRESHOLD_HATE: z.coerce.number().min(0).max(1).default(0.6),
  MOD_THRESHOLD_SELF_HARM: z.coerce.number().min(0).max(1).default(0.5),
  MOD_THRESHOLD_SEXUAL: z.coerce.number().min(0).max(1).default(0.7),
  USER_BAN_FLAG_THRESHOLD: z.coerce.number().int().positive().default(3),
  USER_PERMABAN_FLAG_THRESHOLD: z.coerce.number().int().positive().default(10),

  // ToS / age
  CURRENT_TOS_VERSION: z.string().default('1.0'),
  AGE_REJECTION_BLOCK_DAYS: z.coerce.number().int().positive().default(30),

  // Admin — [AUDIT-C5] number[] with refine for non-empty
  ADMIN_TG_IDS: z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    )
    .refine((arr) => arr.length > 0, 'At least one valid admin TG ID required'),
  ADMIN_CHAT_ID: z.coerce.number(),

  // Feature flags — strict boolean parser
  FEATURE_VOICE_INPUT: boolFromEnv.default('true'),
  FEATURE_VOICE_OUTPUT: boolFromEnv.default('true'),
  FEATURE_DOCUMENTS: boolFromEnv.default('true'),
  FEATURE_GROUPS: boolFromEnv.default('true'),
  // Skip the input/output OpenAI Moderation calls entirely when false.
  // Useful in dev where the OpenAI key is rate-limited (429 fail-open
  // still adds 4-5s per call). Production should keep this true so
  // jailbreak / blacklist / category thresholds keep firing.
  FEATURE_MODERATION: boolFromEnv.default('true'),
  KILL_SWITCH: boolFromEnv.default('false'),
  // Toggle between TypingIndicatorSink (false — [AUDIT-C7] safe) and
  // StreamingEditSink (true — UX win on fast models, see streaming-sink.ts).
  STREAMING_USE_EDIT: boolFromEnv.default('true'),

  // Context
  CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(256_000),
  DOCUMENT_MAX_TOKENS: z.coerce.number().int().positive().default(200_000),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
});

export type Env = z.infer<typeof EnvSchema>;

// Parse at import time so the app crashes immediately with a readable error
// (rather than failing somewhere deep inside a request handler later).
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // We can't use the pino logger here — config.ts is imported from logger.ts,
  // so pino itself isn't ready yet. Plain stderr write avoids the lint rule
  // against console.* without needing a suppression comment.
  process.stderr.write('Invalid environment variables:\n');
  for (const issue of parsed.error.issues) {
    process.stderr.write(`  ${issue.path.join('.')}: ${issue.message}\n`);
  }
  process.exit(1);
}

export const env: Env = parsed.data;
