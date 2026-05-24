# Gonka Bot — Техническое задание для MVP (TypeScript) — v1.2

> **Имплементатор:** Claude Opus 4.7 (vibe-coding), с последующим human review TS-разработчиком.
> **Срок:** 7-8 недель full-time эквивалент (Неделя 7 разделена на 7A polish + 7B deploy/launch).
> **Цель документа:** дать имплементатору всю информацию для построения MVP без необходимости задавать уточняющие вопросы по архитектуре, контрактам, флоу и acceptance criteria.
> **Стек:** TypeScript 5.4 + Node.js 22 LTS + grammY + Drizzle ORM + PostgreSQL 16 + Redis 7 + Hono.
> **Версия:** 1.2 (25 мая 2026).

### Что изменилось vs v1.1

Закрыты все находки [TZ_AUDIT_v1.1.md](TZ_AUDIT_v1.1.md):
- **N1**: `incrementFlagCount` — атомарная SQL-операция с проверкой порогов и установкой ban в одной транзакции.
- **N2**: `StreamingTextSink` принимает `replyToMessageId` для группового reply-режима.
- **N3**: voice output **только** в private DM (`ctx.chat.type === 'private'`).
- **N4**: `startNew` транзакционно деактивирует старые active-DM-conversations.
- **N5**: lazy reset `flag_count_week` через SQL CASE.
- **P1-P5**: синхронизированы §9.1, §9.4, §10.1, §10.2, §10.3, §14.3, §15.
- **B1**: `resetDailyFlags` убран — Redis TTL делает всё.
- **B3**: `/delete_my_data` использует **anonymize** для audit_log (security exemption).
- **C8**: документ заменяет контекст с явным UX-сообщением.
- **H4, H7**: задокументировано поведение rate limit при отказе и failed Whisper.
- **L14**: `renderSystemPrompt` добавляет `ALWAYS respond in: {userLang}` в конце.
- **L20**: введён [BACKLOG.md](BACKLOG.md) для Phase 2+.
- **X1-X15**: синхронизированы все контракты (типы, методы, поля БД, middleware order).
- **A10**: Неделя 7 разделена на 7A (Polish/ToS) и 7B (Deploy/Launch).
- Удалён `createDraftStreamingSink` и флаг `STREAMING_USE_DRAFT` — единственный sink в MVP это `TypingIndicatorSink`.

### Заметка имплементатору (vibe-coding)

- **Строгие типы везде**: `strict: true`, никакого `any`, `as const`, discriminated unions, branded types.
- **Zod на runtime-границах**: env, входящие webhook'и, ответы внешних API. Fail loudly.
- **Result-pattern для бизнес-ошибок**: возвращать `Result<T, E>`. `throw` — только для unexpected.
- **Тонкие модули с явными интерфейсами**: каждый сервис — отдельный файл, экспортирует интерфейс + factory. DI через конструктор.
- **Никаких side effects при импорте**.
- **No magic strings**: `as const` объекты для slugs/event types/severity.
- **`noUncheckedIndexedAccess`**: `arr[0]` это `T | undefined`. Не использовать `!` без обоснования. Проверять через early return или явный throw.
- **`exactOptionalPropertyTypes`**: если упрётся в grammY-типы — оставить TODO и точечно прокинуть `undefined` через `as`. Не отключать опцию глобально.
- **Каждое отклонение от ТЗ помечать комментарием** `// AUDIT-Xn: причина` со ссылкой на пункт.

---

## 0. Содержание

1. Обзор продукта и цели
2. Архитектура и стек
3. Структура проекта
4. Переменные окружения
5. Схема базы данных + relations
6. Модули и их контракты
7. Команды бота и handler'ы
8. UX-флоу пошагово
9. Внешние интеграции
10. Content Safety pipeline
11. Rate limiting и cost tracking
12. Логирование, мониторинг, cron
13. Deployment
14. Тестирование
15. Фазированный план реализации
16. Acceptance criteria
17. Out of scope (см. также [BACKLOG.md](BACKLOG.md))

---

## 1. Обзор продукта и цели

### Что строим

Telegram-бот = AI-агент в Telegram, работающий на модели **Kimi K2.6** через децентрализованную сеть **Gonka**. Полностью бесплатный для конечного пользователя, без регистрации.

### Аудитория

Международная массовая аудитория. Мультиязычность обязательна — UX-копирайтинг минимум на 6 языках (EN, RU, ES, AR, ZH, DE). Сам Kimi отвечает на языке юзера автоматически.

### Бизнес-цель

Drive adoption для Gonka Network, накопить метрики DAU/retention/tokens для питча команде Gonka на грант из ecosystem fund.

### Что бот умеет в MVP

1. Текстовый чат с typing-indicator до показа финального ответа (см. §6.1b)
2. Multi-turn диалоги с историей в DM
3. Voice input (голосовое → Whisper → текстовый pipeline)
4. Voice output (опциональный, по `/voice on`)
5. Document upload (PDF, DOCX, TXT) с использованием 256K-контекста Kimi
6. 10 пред-сделанных персонажей
7. Single-turn ответы в групповых чатах через `@mention` (Privacy ON)
8. Content safety pipeline на input/output
9. Per-user rate limiting
10. Cost ceiling с kill-switch
11. ToS + age gate с rejection block 30 дней
12. Audit log + user reputation
13. `/delete_my_data` (GDPR)

---

## 2. Архитектура и стек

### Технологический стек

| Компонент | Решение | Версия |
|-----------|---------|--------|
| Язык | TypeScript | 5.4+ (strict) |
| Runtime | Node.js | 22 LTS |
| Package manager | pnpm | 9+ |
| Bot framework | grammY | 1.30+ |
| ORM | Drizzle ORM | latest |
| Postgres | postgres-js + Postgres | 16 |
| Redis | ioredis | 5+ + Redis 7 |
| Cron (MVP) | node-cron | 3+ |
| HTTP client | undici (built-in Node 22) | — |
| HTTP server | Hono | 4+ |
| Validation | zod | 3+ |
| SSE parsing | eventsource-parser | 3+ |
| PDF | unpdf | latest |
| DOCX | mammoth | 1+ |
| Audio convert | spawn ffmpeg (binary в Docker) | — |
| Token estimate | js-tiktoken | latest |
| Containers | Docker + Compose v2 | — |
| Reverse proxy | Caddy | 2+ |
| Logging | pino | latest |
| Tests | vitest + ioredis-mock + @testcontainers/postgresql | latest |
| Lint/format | Biome | latest |
| Build | tsx (dev), tsc (prod) | — |

**Примечание про токенайзер [AUDIT-H3]:** Kimi K2.6 использует другой токенайзер, расхождение с tiktoken до 30%. tiktoken — **только для предварительной оценки** ("поместится ли"). Для cost tracking — **только `usage`** из ответа gateway.

**Примечание про ffmpeg [AUDIT-H1]:** Telegram `sendVoice` принимает только OGG/Opus. Edge-TTS отдаёт MP3 → ffmpeg конвертирует.

### package.json scripts

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "dev:pretty": "tsx watch src/main.ts | pino-pretty",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check src",
    "lint:fix": "biome check --apply src",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

### tsconfig.json (обязательно)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### Внешние сервисы

| Сервис | Назначение | Стоимость |
|--------|-----------|-----------|
| mingles.ai gateway | Kimi K2.6 через Gonka | Бесплатно (beta) |
| OpenAI Moderation | Input/Output safety | Бесплатно |
| OpenAI Whisper | Voice → text | $0.006/min |
| Edge-TTS (`msedge-tts`) | Text → voice | Бесплатно |

### Высокоуровневая архитектура

```
Telegram → Caddy (HTTPS) → Hono → grammY webhook → composers
                                       ↓
                                    services (DI factory)
                                       ↓
                                    Postgres / Redis / External APIs
```

### HTTP-сервер: grammY + Hono

```typescript
import { Hono } from 'hono';
import { webhookCallback } from 'grammy';

const app = new Hono();
app.get('/health', healthHandler);     // liveness
app.get('/ready', readyHandler);       // readiness: DB + Redis pings
app.post(env.WEBHOOK_PATH, webhookCallback(bot, 'hono', {
  secretToken: env.WEBHOOK_SECRET,
}));
```

---

## 3. Структура проекта

```
gonka-bot/
├── docker-compose.yml
├── Caddyfile
├── Dockerfile
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── tsconfig.build.json
├── biome.json
├── drizzle.config.ts
├── vitest.config.ts
├── README.md
├── BACKLOG.md                          # Phase 2+ idea log [AUDIT-L20]
├── .env.example
├── .gitignore
├── src/
│   ├── main.ts                         # entry: build services → wire bot → start Hono → register crons
│   ├── config.ts                       # zod env
│   ├── types.ts                        # Result, branded IDs, DomainError, Tokenizer
│   ├── bot/
│   │   ├── app.ts                      # bot instance + middleware order [AUDIT-X10]
│   │   ├── context.ts                  # MyContext type [AUDIT-X4,X5,X9]
│   │   ├── middlewares/
│   │   │   ├── logging.ts              # 1st: traceId + child logger
│   │   │   ├── auth.ts                 # 2nd: user lookup + ban check
│   │   │   ├── kill-switch.ts          # 3rd: maintenance mode
│   │   │   ├── i18n.ts                 # 4th: ctx.lang + ctx.t
│   │   │   └── (rate-limit — в handler'ах, per-kind)
│   │   ├── composers/
│   │   │   ├── start.ts                # /start + ToS + age gate
│   │   │   ├── help.ts
│   │   │   ├── chat.ts                 # text in DM
│   │   │   ├── voice.ts                # /voice + voice messages
│   │   │   ├── document.ts
│   │   │   ├── persona.ts
│   │   │   ├── new.ts
│   │   │   ├── about.ts
│   │   │   ├── report.ts
│   │   │   ├── lang.ts                 # /lang (отдельно от start) [AUDIT-C3]
│   │   │   ├── delete-data.ts          # /delete_my_data [AUDIT-A1]
│   │   │   ├── group.ts                # @mention, single-turn [AUDIT-C9]
│   │   │   └── admin.ts                # /kill, /unkill, /stats
│   │   └── keyboards/
│   │       ├── main-menu.ts
│   │       ├── personas.ts
│   │       ├── tos.ts
│   │       └── confirm.ts
│   ├── services/
│   │   ├── gonka-client.ts             # SSE через eventsource-parser
│   │   ├── streaming-sink.ts           # TypingIndicatorSink [AUDIT-C1,C7]
│   │   ├── moderation.ts               # OpenAI + jailbreak + blacklist
│   │   ├── jailbreak-detector.ts
│   │   ├── blacklist-checker.ts
│   │   ├── voice.ts                    # Whisper + Edge-TTS + ffmpeg
│   │   ├── document.ts                 # PDF/DOCX/TXT
│   │   ├── persona.ts
│   │   ├── rate-limiter.ts
│   │   ├── cost-tracker.ts
│   │   ├── conversation.ts
│   │   ├── users.ts                    # user lifecycle, deleteCascade [AUDIT-X5]
│   │   ├── user-reports.ts             # /report storage [AUDIT-X6]
│   │   ├── i18n.ts
│   │   └── crons.ts                    # node-cron register
│   ├── db/
│   │   ├── schema.ts
│   │   ├── relations.ts                # Drizzle relations [AUDIT-M4]
│   │   ├── client.ts                   # createDb factory
│   │   └── repositories/
│   │       ├── users.ts
│   │       ├── conversations.ts
│   │       ├── messages.ts
│   │       ├── audit-log.ts
│   │       ├── personas.ts
│   │       ├── user-reports.ts
│   │       └── usage-stats.ts
│   ├── http/
│   │   ├── server.ts                   # Hono app
│   │   ├── health.ts                   # /health
│   │   └── ready.ts                    # /ready (DB + Redis ping) [AUDIT-L10]
│   ├── locales/
│   │   ├── en.json
│   │   ├── ru.json
│   │   ├── es.json
│   │   ├── ar.json
│   │   ├── zh.json
│   │   └── de.json
│   ├── utils/
│   │   ├── result.ts
│   │   ├── retry.ts
│   │   ├── tokenizer.ts                # js-tiktoken wrapper [AUDIT-X3]
│   │   ├── logger.ts                   # pino + traceId helpers [AUDIT-L12]
│   │   ├── ids.ts                      # branded ID factories
│   │   ├── telegram-split.ts           # split >4000 chars [AUDIT-A4]
│   │   └── ffmpeg.ts                   # MP3 → OGG/Opus
│   └── data/
│       ├── personas.yaml
│       └── blacklist/
│           ├── en.json
│           ├── ru.json
│           └── ...
├── drizzle/
│   └── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── scripts/
    ├── migrate.ts                      # used in Docker entrypoint [AUDIT-M5]
    ├── set-webhook.ts
    └── seed-personas.ts
```

---

## 4. Переменные окружения

Все переменные **валидируются через zod при старте**. Невалидная env → крэш с понятной ошибкой.

### `.env.example`

```bash
# ===== Node =====
NODE_ENV=development                # development | production | test
PORT=8080

# ===== Telegram =====
BOT_TOKEN=                          # от BotFather
BOT_USERNAME=                       # без @
WEBHOOK_URL=                        # https://bot.yourdomain.com/webhook
WEBHOOK_SECRET=                     # openssl rand -hex 32 [AUDIT-A3]
WEBHOOK_PATH=/webhook

# ===== Gonka =====
GONKA_GATEWAY_URL=https://gateway.mingles.ai/v1
GONKA_API_KEY=
GONKA_MODEL=Kimi-K2.6
GONKA_TIMEOUT_MS=120000
GONKA_MAX_RETRIES=2

# ===== OpenAI =====
OPENAI_API_KEY=
OPENAI_MODERATION_MODEL=omni-moderation-latest
OPENAI_WHISPER_MODEL=whisper-1

# ===== Database / Redis =====
DATABASE_URL=postgres://gonka:password@postgres:5432/gonka_bot
REDIS_URL=redis://redis:6379/0

# ===== Rate limits =====
RATE_LIMIT_TEXT_PER_DAY=30
RATE_LIMIT_VOICE_PER_DAY=5
RATE_LIMIT_DOCUMENT_PER_DAY=3
MAX_DOCUMENT_SIZE_MB=10
MAX_VOICE_SIZE_MB=25                # Whisper limit
MAX_MESSAGE_LENGTH_CHARS=8000

# ===== Cost controls =====
DAILY_BUDGET_USD=50
COST_ALERT_THRESHOLD_USD=30
COST_PER_INPUT_TOKEN_USD=0.0000003
COST_PER_OUTPUT_TOKEN_USD=0.0000012

# ===== Moderation thresholds (internal category names — см. §10) =====
MOD_THRESHOLD_SEXUAL_MINORS=0.2
MOD_THRESHOLD_HARM=0.6
MOD_THRESHOLD_VIOLENCE=0.7
MOD_THRESHOLD_HATE=0.6
MOD_THRESHOLD_SELF_HARM=0.5
MOD_THRESHOLD_SEXUAL=0.7
USER_BAN_FLAG_THRESHOLD=3
USER_PERMABAN_FLAG_THRESHOLD=10

# ===== ToS / age =====
CURRENT_TOS_VERSION=1.0             # bump → юзеров принудительно ре-акцептит [AUDIT-H10]
AGE_REJECTION_BLOCK_DAYS=30         # [AUDIT-H9]

# ===== Admin =====
ADMIN_TG_IDS=123456789,987654321
ADMIN_CHAT_ID=

# ===== Feature flags =====
FEATURE_VOICE_INPUT=true
FEATURE_VOICE_OUTPUT=true
FEATURE_DOCUMENTS=true
FEATURE_GROUPS=true
KILL_SWITCH=false

# ===== Context window =====
CONTEXT_WINDOW_TOKENS=256000        # Kimi K2.6
DOCUMENT_MAX_TOKENS=200000

# ===== Logging =====
LOG_LEVEL=info
LOG_FORMAT=json                     # json | pretty (только для local dev)
```

### `src/config.ts`

**[AUDIT-C4 — критичный security fix]:** `z.coerce.boolean()` приводит **любую непустую строку** к `true`, включая `"false"` и `"0"`. Это значит `KILL_SWITCH=false` парсится как `true`. Используем явный enum:

```typescript
import { z } from 'zod';
import 'dotenv/config';

// [AUDIT-C4] безопасный boolean — принимаем ТОЛЬКО эти значения
const boolFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  WEBHOOK_URL: z.string().url(),
  WEBHOOK_SECRET: z.string().min(16),
  WEBHOOK_PATH: z.string().default('/webhook'),

  GONKA_GATEWAY_URL: z.string().url(),
  GONKA_API_KEY: z.string().min(1),
  GONKA_MODEL: z.string().default('Kimi-K2.6'),
  GONKA_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GONKA_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODERATION_MODEL: z.string().default('omni-moderation-latest'),
  OPENAI_WHISPER_MODEL: z.string().default('whisper-1'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  RATE_LIMIT_TEXT_PER_DAY: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_VOICE_PER_DAY: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_DOCUMENT_PER_DAY: z.coerce.number().int().positive().default(3),
  MAX_DOCUMENT_SIZE_MB: z.coerce.number().int().positive().default(10),
  MAX_VOICE_SIZE_MB: z.coerce.number().int().positive().default(25),
  MAX_MESSAGE_LENGTH_CHARS: z.coerce.number().int().positive().default(8000),

  DAILY_BUDGET_USD: z.coerce.number().positive().default(50),
  COST_ALERT_THRESHOLD_USD: z.coerce.number().positive().default(30),
  COST_PER_INPUT_TOKEN_USD: z.coerce.number().positive(),
  COST_PER_OUTPUT_TOKEN_USD: z.coerce.number().positive(),

  MOD_THRESHOLD_SEXUAL_MINORS: z.coerce.number().min(0).max(1).default(0.2),
  MOD_THRESHOLD_HARM: z.coerce.number().min(0).max(1).default(0.6),
  MOD_THRESHOLD_VIOLENCE: z.coerce.number().min(0).max(1).default(0.7),
  MOD_THRESHOLD_HATE: z.coerce.number().min(0).max(1).default(0.6),
  MOD_THRESHOLD_SELF_HARM: z.coerce.number().min(0).max(1).default(0.5),
  MOD_THRESHOLD_SEXUAL: z.coerce.number().min(0).max(1).default(0.7),
  USER_BAN_FLAG_THRESHOLD: z.coerce.number().int().positive().default(3),
  USER_PERMABAN_FLAG_THRESHOLD: z.coerce.number().int().positive().default(10),

  CURRENT_TOS_VERSION: z.string().default('1.0'),
  AGE_REJECTION_BLOCK_DAYS: z.coerce.number().int().positive().default(30),

  // [AUDIT-C5] strict parsing + non-empty refine
  ADMIN_TG_IDS: z
    .string()
    .transform((s) =>
      s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0)
    )
    .refine((arr) => arr.length > 0, 'At least one valid admin TG ID required'),
  ADMIN_CHAT_ID: z.coerce.number(),

  FEATURE_VOICE_INPUT: boolFromEnv.default('true'),
  FEATURE_VOICE_OUTPUT: boolFromEnv.default('true'),
  FEATURE_DOCUMENTS: boolFromEnv.default('true'),
  FEATURE_GROUPS: boolFromEnv.default('true'),
  KILL_SWITCH: boolFromEnv.default('false'),

  CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(256_000),
  DOCUMENT_MAX_TOKENS: z.coerce.number().int().positive().default(200_000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);
```

---

## 5. Схема базы данных + relations

### `src/db/schema.ts`

```typescript
import { pgTable, bigserial, serial, bigint, text, timestamp, integer, boolean, numeric, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tgId: bigint('tg_id', { mode: 'number' }).notNull().unique(),
  tgUsername: text('tg_username'),
  firstName: text('first_name'),
  languageCode: text('language_code').default('en'),

  tosAcceptedAt: timestamp('tos_accepted_at', { withTimezone: true }),
  tosVersion: text('tos_version'),
  ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
  // [AUDIT-H9] block повторного /start после "не 18+"
  ageRejectedAt: timestamp('age_rejected_at', { withTimezone: true }),

  activePersonaId: integer('active_persona_id'),
  activeConversationId: bigint('active_conversation_id', { mode: 'number' }),

  flagCountTotal: integer('flag_count_total').default(0).notNull(),
  flagCountWeek: integer('flag_count_week').default(0).notNull(),
  flagCountWeekResetAt: timestamp('flag_count_week_reset_at', { withTimezone: true }).defaultNow().notNull(),
  bannedUntil: timestamp('banned_until', { withTimezone: true }),
  bannedPermanent: boolean('banned_permanent').default(false).notNull(),
  banReason: text('ban_reason'),

  voiceOutputEnabled: boolean('voice_output_enabled').default(false).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tgIdIdx: uniqueIndex('idx_users_tg_id').on(t.tgId),
  bannedIdx: index('idx_users_banned').on(t.bannedUntil),
}));

export const personas = pgTable('personas', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  nameKey: text('name_key').notNull(),
  descriptionKey: text('description_key').notNull(),
  emoji: text('emoji').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
  personaId: integer('persona_id').references(() => personas.id),
  title: text('title'),
  documentText: text('document_text'),
  documentName: text('document_name'),
  documentTokens: integer('document_tokens'),
  isActive: boolean('is_active').default(true).notNull(),
  // [AUDIT-P5] Phase 2 reply-threads. В MVP не используется. Nullable, оставлено для миграции вперёд.
  groupChatId: bigint('group_chat_id', { mode: 'number' }),
  botMessageId: bigint('bot_message_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userActiveIdx: index('idx_conversations_user_active').on(t.userId, t.isActive),
  groupThreadIdx: index('idx_conversations_group_thread').on(t.groupChatId, t.botMessageId),
}));
```

**[AUDIT-M11, N4, B5] Partial unique index** — гарантирует ровно одну active DM-conversation на юзера. Drizzle не имеет нативного синтаксиса для partial index → создаётся **ручной миграцией** (после `drizzle-kit generate` дописываем SQL):

```sql
CREATE UNIQUE INDEX uniq_user_active_conv
  ON conversations(user_id)
  WHERE is_active = true AND group_chat_id IS NULL;
```

```typescript
export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conversationId: bigint('conversation_id', { mode: 'number' }).notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  // [AUDIT-X1] 'system' зарезервировано на Phase 2 (system markers в истории). В MVP не пишем.
  role: text('role', { enum: ['system', 'user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  // [AUDIT-X7, X13] Telegram message_id — нужен для /report (найти наш ответ по reply)
  tgMessageId: bigint('tg_message_id', { mode: 'number' }),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),    // [AUDIT-L2]
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  convIdx: index('idx_messages_conv').on(t.conversationId, t.createdAt),
  tgMsgIdx: index('idx_messages_tg_msg').on(t.tgMessageId),
}));

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // [AUDIT-B3] nullable — при /delete_my_data anonymize: userId = null
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  eventType: text('event_type').notNull(),
  severity: text('severity', { enum: ['low', 'medium', 'high', 'critical'] }).notNull(),
  contentHash: text('content_hash'),
  contentExcerpt: text('content_excerpt'),
  categories: jsonb('categories'),
  moderationScores: jsonb('moderation_scores'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('idx_audit_user').on(t.userId, t.createdAt),
  eventIdx: index('idx_audit_event').on(t.eventType, t.createdAt),
}));

export const usageStatsDaily = pgTable('usage_stats_daily', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  date: text('date').notNull(),                                // YYYY-MM-DD
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  textMessages: integer('text_messages').default(0).notNull(),
  voiceMessages: integer('voice_messages').default(0).notNull(),
  documents: integer('documents').default(0).notNull(),
  tokensInput: bigint('tokens_input', { mode: 'number' }).default(0).notNull(),
  tokensOutput: bigint('tokens_output', { mode: 'number' }).default(0).notNull(),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).default('0').notNull(),
}, (t) => ({
  dateUserIdx: uniqueIndex('idx_usage_date_user').on(t.date, t.userId),
  dateIdx: index('idx_usage_date').on(t.date),
}));

export const userReports = pgTable('user_reports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  reporterUserId: bigint('reporter_user_id', { mode: 'number' }).references(() => users.id),
  messageId: bigint('message_id', { mode: 'number' }).references(() => messages.id),
  reason: text('reason'),
  status: text('status', { enum: ['pending', 'reviewed', 'actioned'] }).default('pending').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Persona = typeof personas.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
```

### `src/db/relations.ts` [AUDIT-M4]

```typescript
import { relations } from 'drizzle-orm';
import { users, conversations, messages, personas, auditLog, userReports } from './schema';

export const usersRelations = relations(users, ({ many, one }) => ({
  conversations: many(conversations),
  activePersona: one(personas, {
    fields: [users.activePersonaId],
    references: [personas.id],
  }),
  activeConversation: one(conversations, {
    fields: [users.activeConversationId],
    references: [conversations.id],
  }),
  auditEvents: many(auditLog),
  reports: many(userReports, { relationName: 'reporter' }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  persona: one(personas, { fields: [conversations.personaId], references: [personas.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  reports: many(userReports),
}));

export const personasRelations = relations(personas, ({ many }) => ({
  conversations: many(conversations),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(users, { fields: [auditLog.userId], references: [users.id] }),
}));

export const userReportsRelations = relations(userReports, ({ one }) => ({
  reporter: one(users, {
    fields: [userReports.reporterUserId],
    references: [users.id],
    relationName: 'reporter',
  }),
  message: one(messages, { fields: [userReports.messageId], references: [messages.id] }),
}));
```

### `drizzle.config.ts`

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

### Команды миграций

```bash
pnpm db:generate    # generate migration from schema.ts
pnpm db:migrate     # apply migrations
pnpm db:studio      # web UI
```

После `db:generate` для partial unique index — добавить вручную в `drizzle/migrations/0001_partial_index.sql`:
```sql
CREATE UNIQUE INDEX uniq_user_active_conv
  ON conversations(user_id)
  WHERE is_active = true AND group_chat_id IS NULL;
```

---

## 6. Модули и их контракты

### 6.0 Общие типы (`src/types.ts`)

```typescript
// Branded IDs
export type UserId = number & { readonly __brand: 'UserId' };
export type ConversationId = number & { readonly __brand: 'ConversationId' };
export type MessageId = number & { readonly __brand: 'MessageId' };
export type PersonaId = number & { readonly __brand: 'PersonaId' };
export type TelegramUserId = number & { readonly __brand: 'TelegramUserId' };
export type TelegramMessageId = number & { readonly __brand: 'TelegramMessageId' };

// Result pattern
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// Domain errors
export type DomainError =
  | { kind: 'rate_limit'; current: number; limit: number; resetsInSec: number }
  | { kind: 'banned'; reason: string; until: Date | null }
  | { kind: 'moderation_blocked'; categories: string[] }
  | { kind: 'kill_switch_active' }
  | { kind: 'service_unavailable'; service: string }
  | { kind: 'document_overflow'; reservedTokens: number }
  | { kind: 'validation'; field: string; message: string };

// [AUDIT-X3] Tokenizer interface (only estimate, не для cost)
export interface Tokenizer {
  estimate(text: string): number;
}

export type Logger = import('pino').Logger;
```

### 6.1 `services/gonka-client.ts`

```typescript
export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage { role: ChatRole; content: string; }

export interface StreamChunk {
  delta: string;
  tokensInput?: number;          // только в финальном
  tokensOutput?: number;
  finishReason?: 'stop' | 'length' | 'content_filter' | null;
  done: boolean;
}

export interface ChatStreamOptions {
  messages: ChatMessage[];
  maxTokens?: number;            // default 4096
  temperature?: number;          // default 0.7
  signal?: AbortSignal;
}

export interface GonkaClient {
  chatStream(opts: ChatStreamOptions): AsyncIterable<StreamChunk>;
  chatComplete(opts: Omit<ChatStreamOptions, 'signal'>): Promise<Result<{
    content: string;
    tokensInput: number;
    tokensOutput: number;
  }, DomainError>>;
}

export function createGonkaClient(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger: Logger;
}): GonkaClient;
```

**Требования:**
- `fetch` (Node 22) + `AbortController` для таймаутов.
- Retry с exponential backoff (max 2) на 5xx и network errors. **Не ретраит** 4xx.
- Логирует: длительность, токены, стоимость, `usageDegraded`.
- **[AUDIT-H2]** SSE-парсинг через `eventsource-parser`:

```typescript
import { createParser, type ParseEvent } from 'eventsource-parser';

const parser = createParser((event: ParseEvent) => {
  if (event.type !== 'event') return;
  if (event.data === '[DONE]') { /* финал */ return; }
  const chunk = JSON.parse(event.data);
  // emit StreamChunk
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  parser.feed(decoder.decode(value, { stream: true }));
}
```

- **[AUDIT-L13]** Если `usage` отсутствует — логируем `warn` и оцениваем через `js-tiktoken`, помечаем `usageDegraded: true` в логе. **Cost всё равно считается** (по оценке), просто менее точно.

### 6.1b `services/streaming-sink.ts` [AUDIT-C1, C7, N2]

**Контекст:**
- `sendMessageDraft` (Bot API 9.5, март 2026) — есть, но имеет известные edge-cases (`TEXTDRAFT_PEER_INVALID`).
- **Главное [AUDIT-C7]:** чтобы output moderation реально защищала, нельзя показывать накапливающийся текст до его проверки.
- **Решение MVP:** стримим в hidden buffer; юзер видит только `sendChatAction('typing')` (5-сек heartbeat); финальный текст показываем **после** output moderation через `sendMessage`/`editMessageText`.

```typescript
export interface StreamingTextSink {
  /** Стримит чанк "в воздух" — обновляет typing-индикатор. Текст НЕ виден юзеру. */
  push(chunk: string): Promise<void>;
  /** Output moderation прошла → показываем финальный текст. Возвращает Telegram message_id. */
  commit(finalText: string): Promise<{ tgMessageId: number }>;
  /** Output moderation провалена ИЛИ exception → ничего не показываем, останавливаем typing. */
  abort(): Promise<void>;
}

export interface TypingIndicatorSinkOptions {
  ctx: MyContext;
  /** Telegram message_id для reply (в группе). Если undefined — обычный ctx.reply. [AUDIT-N2] */
  replyToMessageId?: number;
  /** Интервал heartbeat typing-индикатора. Telegram держит typing ~5 сек, default 4000ms. */
  refreshIntervalMs?: number;
}

export function createTypingIndicatorSink(opts: TypingIndicatorSinkOptions): StreamingTextSink;
```

**Имплементация (псевдо-код):**

```typescript
export function createTypingIndicatorSink({
  ctx, replyToMessageId, refreshIntervalMs = 4000
}: TypingIndicatorSinkOptions): StreamingTextSink {
  let aborted = false;
  let committed = false;

  // Heartbeat typing
  const sendTyping = () => ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {});
  sendTyping();
  const interval = setInterval(() => { if (!aborted && !committed) sendTyping(); }, refreshIntervalMs);

  return {
    async push() { /* no-op — typing уже идёт. Можно использовать chunk для chunked-moderation в Phase 2 */ },
    async commit(finalText) {
      committed = true;
      clearInterval(interval);
      const replyOpts = replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId } }
        : {};
      const sent = await ctx.reply(finalText, replyOpts);
      return { tgMessageId: sent.message_id };
    },
    async abort() {
      aborted = true;
      clearInterval(interval);
    },
  };
}
```

**Использование в handler'е (см. §8.2):** стриминг идёт в sink, текст показывается только после output moderation. Это закрывает [AUDIT-C7] race.

### 6.2 `services/moderation.ts` [AUDIT-H11, H12, N1, N5]

**[AUDIT-H12]** OpenAI Moderation возвращает категории со слешами. Маппинг обязателен:

```typescript
export const OPENAI_TO_INTERNAL_CATEGORY = {
  'sexual': 'sexual',
  'sexual/minors': 'sexualMinors',        // critical
  'hate': 'hate',
  'hate/threatening': 'hate',
  'harassment': 'harm',
  'harassment/threatening': 'harm',
  'self-harm': 'selfHarm',
  'self-harm/intent': 'selfHarm',
  'self-harm/instructions': 'selfHarm',
  'violence': 'violence',
  'violence/graphic': 'violence',
} as const;

export type InternalCategory =
  typeof OPENAI_TO_INTERNAL_CATEGORY[keyof typeof OPENAI_TO_INTERNAL_CATEGORY];

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
}

export interface ModerationService {
  /**
   * Pipeline: regex blacklist → jailbreak detector → OpenAI Moderation → mapping → thresholds.
   *
   * Side effects при block:
   *  - audit_log запись
   *  - [AUDIT-H11] sexualMinors → МГНОВЕННЫЙ permaban + admin alert. БЕЗ инкремента.
   *  - иначе: incrementFlagCount (атомарно, с проверкой порогов и установкой ban в той же tx)
   */
  checkInput(text: string, userId: UserId, lang: string): Promise<ModerationResult>;
  checkOutput(text: string, userId: UserId, lang: string): Promise<ModerationResult>;
}

export function createModerationService(deps: {
  openaiApiKey: string;
  jailbreak: JailbreakDetector;
  blacklist: BlacklistChecker;
  users: UsersRepository;
  auditLog: AuditLogRepository;
  thresholds: ModerationThresholds;
  banFlagThreshold: number;       // env: USER_BAN_FLAG_THRESHOLD
  permabanFlagThreshold: number;  // env: USER_PERMABAN_FLAG_THRESHOLD
  bot: Bot;                       // [AUDIT-X15] для admin alert при sexualMinors
  adminChatId: number;
  logger: Logger;
}): ModerationService;
```

**Pseudo-код:**

```typescript
async function checkInput(text, userId, lang): Promise<ModerationResult> {
  // 1. Blacklist (быстро, без сети)
  if (blacklist.check(text)) {
    await auditLog.create({ userId, eventType: 'blacklist', severity: 'low', /* ... */ });
    return { decision: 'block', severity: 'low', /* ... */ };
  }

  // 2. Jailbreak detector
  const jb = jailbreak.detect(text);
  if (jb.matched) {
    await auditLog.create({ userId, eventType: 'jailbreak_attempt', severity: 'high', /* ... */ });
    await incrementFlagCount(userId);  // включает проверку порогов
    return { decision: 'block', severity: 'high', /* ... */ };
  }

  // 3. OpenAI Moderation
  const apiResult = await openai.moderations.create({ input: text, model: '...' });
  const r = apiResult.results[0];
  if (!r) throw new Error('Empty moderation response');

  // 4. Маппинг + пороги
  const triggered: InternalCategory[] = [];
  for (const [openaiCat, score] of Object.entries(r.category_scores)) {
    const internal = OPENAI_TO_INTERNAL_CATEGORY[openaiCat as keyof typeof OPENAI_TO_INTERNAL_CATEGORY];
    if (!internal) continue;
    if (score >= thresholds[internal] && !triggered.includes(internal)) {
      triggered.push(internal);
    }
  }
  if (triggered.length === 0) return { decision: 'allow', /* ... */ };

  // 5. [AUDIT-H11] sexualMinors — мгновенный permaban БЕЗ инкремента счётчиков
  if (triggered.includes('sexualMinors')) {
    await users.update(userId, {
      bannedPermanent: true,
      banReason: 'csam_protection',
    });
    await auditLog.create({
      userId,
      eventType: 'sexual_minors_detected',
      severity: 'critical',
      categories: r.categories,
      moderationScores: r.category_scores,
    });
    await bot.api.sendMessage(adminChatId,
      `🚨 CRITICAL: sexual/minors detected, user ${userId} permabanned`);
    return { decision: 'block', severity: 'critical', triggeredCategories: triggered, /* ... */ };
  }

  // 6. Обычный flow
  const severity = triggered.some(c => ['selfHarm','violence','hate'].includes(c)) ? 'high' : 'medium';
  await auditLog.create({ userId, eventType: 'flag_input', severity, /* ... */ });
  await incrementFlagCount(userId);
  return { decision: 'block', severity, triggeredCategories: triggered, /* ... */ };
}
```

**[AUDIT-N1, N5] `incrementFlagCount` — атомарная SQL операция:**

```typescript
// users.repository.incrementFlagCount(userId): Promise<{ flagCountWeek, flagCountTotal, banned }>
async function incrementFlagCount(userId: UserId, banThreshold: number, permabanThreshold: number) {
  return db.transaction(async (tx) => {
    // Lazy reset + increment в одном UPDATE
    const [updated] = await tx.execute(sql`
      UPDATE users SET
        flag_count_week = CASE
          WHEN flag_count_week_reset_at < NOW() - INTERVAL '7 days' THEN 1
          ELSE flag_count_week + 1
        END,
        flag_count_week_reset_at = CASE
          WHEN flag_count_week_reset_at < NOW() - INTERVAL '7 days' THEN NOW()
          ELSE flag_count_week_reset_at
        END,
        flag_count_total = flag_count_total + 1,
        updated_at = NOW()
      WHERE id = ${userId}
      RETURNING flag_count_week, flag_count_total
    `);

    // Проверка порогов и установка ban в той же tx
    if (updated.flag_count_total >= permabanThreshold) {
      await tx.update(users).set({
        bannedPermanent: true,
        banReason: 'flag_count_permaban',
      }).where(eq(users.id, userId));
    } else if (updated.flag_count_week >= banThreshold) {
      await tx.update(users).set({
        bannedUntil: sql`NOW() + INTERVAL '24 hours'`,
        banReason: 'flag_count_week_ban',
      }).where(eq(users.id, userId));
    }

    return updated;
  });
}
```

### 6.3 `services/jailbreak-detector.ts`

```typescript
const JAILBREAK_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /forget\s+(all\s+)?(your|previous)\s+(rules|instructions)/i,
  /you\s+are\s+now\s+(DAN|STAN|DUDE)/i,
  /act\s+as\s+(if\s+you\s+(have\s+)?no\s+restrictions|an?\s+unrestricted)/i,
  /pretend\s+(you\s+(have\s+)?no\s+(rules|restrictions))/i,
  /jailbroken?/i,
  /developer\s+mode/i,
  /system\s*:\s*/i,
  /\[\[\s*system\s*\]\]/i,
] as const;

export interface JailbreakDetector {
  detect(text: string): { matched: boolean; pattern?: string };
}

export function createJailbreakDetector(): JailbreakDetector;
```

### 6.4 `services/voice.ts` [AUDIT-H1, M12, L6]

```typescript
export interface VoiceService {
  /** Whisper transcription. lang — ISO 639-1. undefined = auto-detect. */
  transcribe(audioBytes: Uint8Array, language?: string): Promise<Result<string, DomainError>>;
  /** Edge-TTS → MP3 → ffmpeg → OGG/Opus. Готов для sendVoice. */
  synthesize(text: string, language: string): Promise<Result<Uint8Array, DomainError>>;
}

const VOICE_MAP = {
  en: 'en-US-AriaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  es: 'es-ES-ElviraNeural',
  ar: 'ar-EG-SalmaNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  de: 'de-DE-KatjaNeural',
} as const;

export function createVoiceService(deps: {
  openaiApiKey: string;
  ffmpegPath?: string;          // default '/usr/bin/ffmpeg'
  logger: Logger;
}): VoiceService;
```

**[AUDIT-L6] `synthesize` оборачивает Edge-TTS в try/catch и возвращает `Result`:**

```typescript
async function synthesize(text, language): Promise<Result<Uint8Array, DomainError>> {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      VOICE_MAP[language as keyof typeof VOICE_MAP] ?? VOICE_MAP.en,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    );
    const { audioStream } = tts.toStream(text);
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) chunks.push(chunk as Buffer);
    const mp3 = new Uint8Array(Buffer.concat(chunks));
    // [AUDIT-H1] MP3 → OGG/Opus
    const ogg = await mp3ToOggOpus(mp3);
    return ok(ogg);
  } catch (e) {
    deps.logger.warn({ err: e }, 'TTS synthesis failed');
    return err({ kind: 'service_unavailable', service: 'tts' });
  }
}
```

### `src/utils/ffmpeg.ts`

```typescript
import { spawn } from 'node:child_process';

export async function mp3ToOggOpus(mp3: Uint8Array, ffmpegPath = 'ffmpeg'): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-ar', '24000',
      '-ac', '1',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => errs.push(c));
    proc.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)));
      else reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(errs).toString()}`));
    });
    proc.stdin.end(Buffer.from(mp3));
  });
}
```

**[AUDIT-M12]** В handler'е (см. §8.3) проверяем `voice.file_size` и `audio?.file_size` ≤ `MAX_VOICE_SIZE_MB * 1024 * 1024`.

**[AUDIT-H7]** При ошибке Whisper — счётчик `voice` rate-limit **НЕ откатывается** (защита от спама).

### 6.5 `services/document.ts` [AUDIT-L7, M10]

```typescript
export interface DocumentText {
  text: string;
  pages: number;
  tokensEstimate: number;
}

export type DocumentError =
  | { kind: 'too_large'; sizeMb: number; limit: number }
  | { kind: 'unsupported_format'; mimeType: string }
  | { kind: 'parse_failed'; reason: string }
  | { kind: 'too_long'; tokens: number; limit: number };

export interface DocumentService {
  extractText(opts: {
    fileBytes: Uint8Array;
    mimeType: string;
    maxSizeMb: number;
  }): Promise<Result<DocumentText, DocumentError>>;
}

export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
] as const;

export function createDocumentService(deps: {
  tokenizer: Tokenizer;
  logger: Logger;
}): DocumentService;
```

**Имплементация:**
- PDF: `unpdf` (Node 22 + Promise.withResolvers).
- DOCX: `mammoth`.
- TXT/MD: `new TextDecoder('utf-8').decode(bytes)`.

**[AUDIT-L7] Логирование в каждом успешном extract:** `mimeType`, `sizeBytes`, `pages`, `tokensEstimate`, `latencyMs`.

**[AUDIT-M10] Документ-moderation:** §8.4 модерирует **первые 50K символов** (защищает от обхода в начале). В `audit_log.metadata` сохраняем `{ doc_moderated_prefix_only: true, docSize: bytes }` — известное ограничение MVP.

### 6.6 `services/persona.ts` [AUDIT-L14]

```typescript
export type PersonaSlug =
  | 'default' | 'analyst' | 'coder' | 'therapist' | 'translator'
  | 'editor' | 'researcher' | 'teacher' | 'chef' | 'writer';

export interface Persona {
  id: PersonaId;
  slug: PersonaSlug;
  nameKey: string;
  descriptionKey: string;
  emoji: string;
  systemPrompt: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface PersonaService {
  listActive(): Promise<Persona[]>;
  getBySlug(slug: PersonaSlug): Promise<Persona | null>;
  getById(id: PersonaId): Promise<Persona | null>;
  getDefault(): Promise<Persona>;
  /**
   * Финальный prompt:
   *  1. Базовый системный промпт персонажа
   *  2. [AUDIT-L14] явная инструкция языка: "ALWAYS respond in: {userLang}"
   *  3. Если документ — appended в конце с разделителем
   */
  renderSystemPrompt(opts: {
    persona: Persona;
    userLang: string;
    documentText?: string;
    documentName?: string;
  }): string;
}

export function createPersonaService(deps: {
  personas: PersonasRepository;
  logger: Logger;
}): PersonaService;
```

### 6.7 `services/rate-limiter.ts` [AUDIT-H4]

```typescript
export type RateLimitKind = 'text' | 'voice' | 'document';

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  resetsInSec: number;
}

export interface RateLimiter {
  /**
   * Redis pipeline: INCR + EXPIRE 86400. Key = `rl:${kind}:${userId}:${YYYY-MM-DD}`.
   * [AUDIT-H4] Counter инкрементируется ВКЛЮЧАЯ rejected requests — защита от /spam.
   */
  checkAndIncrement(userId: UserId, kind: RateLimitKind): Promise<RateLimitResult>;
}

export function createRateLimiter(deps: {
  redis: Redis;
  limits: Record<RateLimitKind, number>;
  logger: Logger;
}): RateLimiter;
```

### 6.8 `services/cost-tracker.ts` [AUDIT-X14, X15, B1, H5]

```typescript
export type RequestKind = 'text' | 'voice' | 'document';

export interface CostTrackingResult {
  dailyTotalUsd: number;
  overAlertThreshold: boolean;
  overKillThreshold: boolean;
}

export interface CostTracker {
  /** [AUDIT-X14] kind инкрементит соответствующий счётчик в usage_stats_daily */
  trackRequest(opts: {
    userId: UserId;
    kind: RequestKind;
    tokensInput: number;
    tokensOutput: number;
  }): Promise<CostTrackingResult>;

  isKillSwitchActive(): Promise<boolean>;

  // [AUDIT-B1] resetDailyFlags убран — Redis TTL очищает 'cost:alerted:*' автоматически.
}

export function createCostTracker(deps: {
  db: Database;
  redis: Redis;
  bot: Bot;                       // [AUDIT-X15] явный inject
  config: {
    dailyBudgetUsd: number;
    alertThresholdUsd: number;
    costPerInputToken: number;
    costPerOutputToken: number;
    adminChatId: number;
  };
  logger: Logger;
}): CostTracker;
```

### 6.9 `services/conversation.ts` [AUDIT-C6, X7, X8, X13, N4, A5]

```typescript
export interface Conversation {
  id: ConversationId;
  userId: UserId;
  personaId: PersonaId | null;
  title: string | null;
  documentText: string | null;
  documentName: string | null;
  documentTokens: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationService {
  getOrCreateActive(userId: UserId): Promise<Conversation>;

  /**
   * [AUDIT-N4] ТРАНЗАКЦИОННО: деактивирует все active DM-conversations юзера,
   * затем создаёт новую. Защищает partial unique index от violation.
   * Для групп (groupChatId передан) — деактивация НЕ делается (там можно много).
   */
  startNew(userId: UserId, opts?: {
    personaId?: PersonaId;
    groupChatId?: number;
  }): Promise<Conversation>;

  setPersona(conversationId: ConversationId, personaId: PersonaId): Promise<void>;

  /** [AUDIT-X8] used by /new */
  deactivateAllForUser(userId: UserId): Promise<void>;

  /** [AUDIT-X13] tgMessageId сохраняем для /report */
  appendMessage(opts: {
    conversationId: ConversationId;
    role: ChatRole;
    content: string;
    tgMessageId?: number;
    tokensInput?: number;
    tokensOutput?: number;
    costUsd?: number | null;
  }): Promise<MessageId>;

  /**
   * [AUDIT-C6] Возвращает ТОЛЬКО user/assistant. System prompt в handler'е, не в БД.
   * Trim: пары (user+assistant) с конца к началу. Защищает от orphan assistant.
   *
   * [AUDIT-A5] Защита от переполнения 256K окна:
   *  - reservedForSystem + reservedForResponse + 4K buffer
   *  - history тримится до (contextWindow - reserved)
   *  - Если reservedForSystem > (contextWindow - 8K) → Err document_overflow
   */
  getMessagesForLlm(opts: {
    conversationId: ConversationId;
    maxHistory?: number;             // default 20 (пар)
    reservedForSystem: number;
    reservedForResponse?: number;    // default 4096
    contextWindow?: number;          // default 256_000
  }): Promise<Result<ChatMessage[], { kind: 'document_overflow'; reservedTokens: number }>>;

  attachDocument(opts: {
    conversationId: ConversationId;
    text: string;
    documentName: string;
    tokens: number;
  }): Promise<void>;

  /** [AUDIT-X7] для /report */
  findMessageByTgId(userId: UserId, tgMessageId: number): Promise<MessageId | null>;
  /** [AUDIT-X7] последний assistant ответ юзеру (для /report без reply) */
  lastAssistantMessage(userId: UserId): Promise<MessageId | null>;

  // [AUDIT-P5] reserved для Phase 2. В MVP не вызывается.
  saveGroupThread(opts: { conversationId: ConversationId; groupChatId: number; botMessageId: number }): Promise<void>;
  getByGroupThread(opts: { groupChatId: number; botMessageId: number }): Promise<Conversation | null>;
}

export function createConversationService(deps: {
  db: Database;                    // для transaction wrap в startNew
  conversations: ConversationsRepository;
  messages: MessagesRepository;
  tokenizer: Tokenizer;
  logger: Logger;
}): ConversationService;
```

### 6.10 `services/users.ts` [AUDIT-X5, B3]

```typescript
export interface UsersService {
  getOrCreate(opts: { tgId: number; tgUsername?: string; firstName?: string; languageCode?: string }): Promise<User>;
  update(userId: UserId, patch: Partial<User>): Promise<void>;
  /**
   * [AUDIT-A1, B3] GDPR delete cascade.
   * - delete: users, conversations, messages (cascade), user_reports, usage_stats_daily
   * - anonymize (НЕ delete) audit_log: user_id = NULL, content_excerpt = '[deleted]'
   *   (security exemption: оставляем categories+scores для статистики безопасности)
   */
  deleteCascade(userId: UserId): Promise<void>;
}

export function createUsersService(deps: {
  db: Database;
  users: UsersRepository;
  conversations: ConversationsRepository;
  auditLog: AuditLogRepository;
  logger: Logger;
}): UsersService;
```

### 6.11 `services/user-reports.ts` [AUDIT-X6]

```typescript
export interface UserReportsService {
  create(opts: {
    reporterUserId: UserId;
    messageId: MessageId;
    reason?: string;
  }): Promise<{ id: number }>;
}

export function createUserReportsService(deps: {
  userReports: UserReportsRepository;
  bot: Bot;
  adminChatId: number;
  logger: Logger;
}): UserReportsService;
```

### 6.12 `services/i18n.ts` [AUDIT-L4, L16, X11]

```typescript
// [AUDIT-L4] TS 5.4+ / Node 22: with, не assert
import enLocale from '../locales/en.json' with { type: 'json' };
import ruLocale from '../locales/ru.json' with { type: 'json' };
import esLocale from '../locales/es.json' with { type: 'json' };
import arLocale from '../locales/ar.json' with { type: 'json' };
import zhLocale from '../locales/zh.json' with { type: 'json' };
import deLocale from '../locales/de.json' with { type: 'json' };

const LOCALES = { en: enLocale, ru: ruLocale, es: esLocale, ar: arLocale, zh: zhLocale, de: deLocale } as const;

export type SupportedLang = keyof typeof LOCALES;

export interface I18nService {
  /**
   * [AUDIT-L16] Fallback: lang → en → key (с warn).
   * {param} substitution через простой replace.
   */
  t(key: string, lang: SupportedLang | string, params?: Record<string, string | number>): string;
  resolveLang(tgLanguageCode: string | undefined): SupportedLang;
}

export function createI18nService(logger: Logger): I18nService;
```

**[AUDIT-X11]** Если `vitest` не поймёт `with { type: 'json' }` (esbuild) — fallback:
```typescript
import { readFileSync } from 'node:fs';
const enLocale = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
```

### 6.13 `bot/context.ts` [AUDIT-X4, X5, X6, X9]

```typescript
import type { Context, SessionFlavor } from 'grammy';

export interface SessionData {
  // empty — session в БД, не в Redis-сессии grammY
}

export interface CustomCtx {
  // Injected by middleware
  user?: User;
  lang: SupportedLang;
  logger: Logger;                  // [AUDIT-X9] per-request child logger
  traceId: string;                 // [AUDIT-X9]

  services: {
    gonka: GonkaClient;
    moderation: ModerationService;
    voice: VoiceService;
    document: DocumentService;
    persona: PersonaService;
    rateLimit: RateLimiter;
    cost: CostTracker;
    conversation: ConversationService;
    users: UsersService;           // [AUDIT-X5]
    userReports: UserReportsService; // [AUDIT-X6]
    tokenizer: Tokenizer;          // [AUDIT-X4]
    i18n: I18nService;
  };

  t(key: string, params?: Record<string, string | number>): string;
}

export type MyContext = Context & CustomCtx & SessionFlavor<SessionData>;
```

### 6.14 Middleware order [AUDIT-X10]

В `bot/app.ts` middleware регистрируются в строгом порядке:

```typescript
bot.use(loggingMiddleware);        // 1. traceId, child logger — самое раннее
bot.use(servicesInjector);         // 2. ctx.services = { ... }
bot.use(i18nMiddleware);           // 3. ctx.lang + ctx.t (для error messages ниже)
bot.use(authMiddleware);           // 4. lookup user by tgId, проверка ban (НЕ для /start)
bot.use(killSwitchMiddleware);     // 5. maintenance check (после auth — админы пропускаются)
// rate-limit делается в handler'ах per-kind, не в middleware.

bot.use(startComposer);
bot.use(helpComposer);
// ... остальные composers
bot.use(chatComposer);             // обработчик text (последний — catch-all для DM)
bot.use(groupComposer);            // @mention в группе
```

**Обоснования:**
- `logging` → 1: трасс-ID нужен везде, включая ошибки middleware.
- `services` → 2: всё ниже использует `ctx.services`.
- `i18n` → 3: даже error messages из ban-check должны быть на языке юзера.
- `auth` → 4: после i18n, чтобы ban-message локализовать. Skip для `/start` (юзера ещё нет).
- `kill-switch` → 5: после auth, чтобы пропустить админов.

---

## 7. Команды и handler'ы

| Команда | Описание | Где доступна | Composer |
|---------|----------|--------------|---------|
| `/start` | Welcome + ToS + age gate | DM | `start.ts` |
| `/help` | Помощь | DM | `help.ts` |
| `/new` | Сбросить контекст | DM | `new.ts` |
| `/persona` | Выбрать персонажа | DM | `persona.ts` |
| `/about` | Информация о боте | DM, group | `about.ts` |
| `/voice` | Toggle voice output | DM | `voice.ts` |
| `/lang` | Сменить язык интерфейса | DM | `lang.ts` |
| `/report` | Пожаловаться на ответ | DM | `report.ts` |
| `/delete_my_data` | GDPR удаление | DM | `delete-data.ts` |
| `/kill`, `/unkill`, `/stats` | Admin | DM (admin only) | `admin.ts` |

| Тип сообщения | Composer |
|---------------|----------|
| text (DM) | `chat.ts::handleTextMessage` |
| voice (DM) | `voice.ts::handleVoiceMessage` |
| document (DM) | `document.ts::handleDocumentUpload` |
| text с @mention в группе | `group.ts::handleGroupMention` |

---

## 8. UX-флоу

### 8.1 `/start` — first run, ToS, age gate

```
1. /start
2. Lookup user by tg_id:
   - not exist → create with language_code from tg user; → ToS flow
   - [AUDIT-H9] exists, age_rejected_at set < AGE_REJECTION_BLOCK_DAYS ago →
       send t('age.blocked', { daysLeft }); end
   - [AUDIT-H10] exists, tos_version !== env.CURRENT_TOS_VERSION →
       set tos_accepted_at = NULL; ToS flow ("we updated terms")
   - tos_accepted_at NULL → ToS flow
   - tos OK, age_confirmed_at NULL → age gate
   - всё OK → main welcome
3. ToS flow:
   - send t('tos.intro'); keyboard [✅ Accept] [📄 Read full text]
   - Accept → UPDATE users SET tos_accepted_at=NOW(), tos_version=env.CURRENT_TOS_VERSION → age gate
   - Read → send t('tos.full') (включает Privacy [AUDIT-A7]) → wait Accept
4. Age gate:
   - send t('age.question'); keyboard [Yes, 18+] [No]
   - Yes → UPDATE users SET age_confirmed_at=NOW() → main welcome
   - No  → UPDATE users SET age_rejected_at=NOW(); send t('age.under18'); end.
     Повторный /start блокируется AGE_REJECTION_BLOCK_DAYS дней.
5. Main welcome:
   - send t('welcome.text'); main_menu inline keyboard
   - set active_persona_id = default persona id
6. Done.
```

### 8.2 Текстовое сообщение в DM [AUDIT-C7, A4, A5, L13, N3]

```typescript
import { createTypingIndicatorSink } from '../../services/streaming-sink';
import { splitForTelegram } from '../../utils/telegram-split';

export async function handleTextMessage(ctx: MyContext): Promise<void> {
  const user = ctx.user!;
  const text = ctx.message!.text!;
  const { gonka, moderation, rateLimit, cost, conversation, persona, tokenizer } = ctx.services;

  // 1. ban / kill-switch — в middleware

  // 2. Rate limit (счётчик инкрементится даже для rejected — защита от спама [AUDIT-H4])
  const rl = await rateLimit.checkAndIncrement(user.id, 'text');
  if (!rl.allowed) {
    await ctx.reply(ctx.t('rate_limit.text', {
      current: rl.current, limit: rl.limit, hours: Math.ceil(rl.resetsInSec / 3600),
    }));
    return;
  }

  // 3. Length check
  if (text.length > env.MAX_MESSAGE_LENGTH_CHARS) {
    await ctx.reply(ctx.t('error.message_too_long', { limit: env.MAX_MESSAGE_LENGTH_CHARS }));
    return;
  }

  // 4. Input moderation
  const modIn = await moderation.checkInput(text, user.id, ctx.lang);
  if (modIn.decision === 'block') {
    await ctx.reply(ctx.t('moderation.input_blocked'));
    return;
  }

  // 5. Conversation + persona
  const conv = await conversation.getOrCreateActive(user.id);
  const activePersona = await persona.getById((conv.personaId ?? user.activePersonaId) as PersonaId);
  if (!activePersona) {
    ctx.logger.error({ userId: user.id }, 'No active persona');
    await ctx.reply(ctx.t('error.internal'));
    return;
  }

  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'user',
    content: text,
    tgMessageId: ctx.message!.message_id,        // [AUDIT-X13]
  });

  // 6. Build LLM messages
  const systemPrompt = persona.renderSystemPrompt({
    persona: activePersona,
    userLang: ctx.lang,
    documentText: conv.documentText ?? undefined,
    documentName: conv.documentName ?? undefined,
  });
  const systemTokens = tokenizer.estimate(systemPrompt);

  const historyResult = await conversation.getMessagesForLlm({
    conversationId: conv.id,
    reservedForSystem: systemTokens,
  });
  if (!historyResult.ok) {
    // [AUDIT-A5] document overflow
    await ctx.reply(ctx.t('error.context_overflow'));
    return;
  }
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyResult.value,
  ];

  // 7. Streaming в hidden sink (typing-индикатор) [AUDIT-C7]
  const sink = createTypingIndicatorSink({ ctx });
  let accumulated = '';
  let finalUsage: { tokensInput: number; tokensOutput: number; usageDegraded: boolean } | null = null;

  try {
    for await (const chunk of gonka.chatStream({ messages: llmMessages })) {
      accumulated += chunk.delta;
      await sink.push(chunk.delta);
      if (chunk.done) {
        if (chunk.tokensInput != null && chunk.tokensOutput != null) {
          finalUsage = { tokensInput: chunk.tokensInput, tokensOutput: chunk.tokensOutput, usageDegraded: false };
        } else {
          // [AUDIT-L13] usage недоступен — fallback на оценку
          ctx.logger.warn({ userId: user.id }, 'usage missing, tiktoken fallback');
          finalUsage = {
            tokensInput: tokenizer.estimate(JSON.stringify(llmMessages)),
            tokensOutput: tokenizer.estimate(accumulated),
            usageDegraded: true,
          };
        }
      }
    }
  } catch (err) {
    await sink.abort();
    ctx.logger.error({ err, userId: user.id }, 'Streaming failed');
    await ctx.reply(ctx.t('error.service_unavailable'));
    return;
  }

  // 8. Output moderation ПЕРЕД показом [AUDIT-C7]
  const modOut = await moderation.checkOutput(accumulated, user.id, ctx.lang);
  if (modOut.decision === 'block') {
    await sink.abort();
    await ctx.reply(ctx.t('moderation.output_blocked'));
    return;
  }

  // 9. Commit + split >4000 chars [AUDIT-A4]
  const parts = splitForTelegram(accumulated, 4000);
  let firstTgMessageId: number | null = null;
  for (const [i, part] of parts.entries()) {
    if (i === 0) {
      const { tgMessageId } = await sink.commit(part);
      firstTgMessageId = tgMessageId;
    } else {
      const sent = await ctx.reply(part);
      firstTgMessageId ??= sent.message_id;
    }
  }

  // 10. Persist assistant message
  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: accumulated,
    tgMessageId: firstTgMessageId ?? undefined,
    tokensInput: finalUsage?.tokensInput,
    tokensOutput: finalUsage?.tokensOutput,
    costUsd: finalUsage
      ? finalUsage.tokensInput * env.COST_PER_INPUT_TOKEN_USD +
        finalUsage.tokensOutput * env.COST_PER_OUTPUT_TOKEN_USD
      : null,
  });

  // 11. Cost tracking
  if (finalUsage) {
    await cost.trackRequest({
      userId: user.id,
      kind: 'text',
      tokensInput: finalUsage.tokensInput,
      tokensOutput: finalUsage.tokensOutput,
    });
  }

  // 12. Voice output [AUDIT-N3] — ТОЛЬКО в private DM, не в группе
  if (
    user.voiceOutputEnabled &&
    ctx.chat?.type === 'private' &&
    accumulated.length <= 2000
  ) {
    const voiceResult = await ctx.services.voice.synthesize(accumulated, ctx.lang);
    if (voiceResult.ok) {
      await ctx.replyWithVoice(new InputFile(voiceResult.value, 'response.ogg'));
    } else {
      ctx.logger.warn({ err: voiceResult.error }, 'TTS failed (non-fatal)');
    }
  }
}
```

### 8.3 Voice message в DM [AUDIT-M12, H7]

```typescript
export async function handleVoiceMessage(ctx: MyContext): Promise<void> {
  const voice = ctx.message!.voice ?? ctx.message!.audio;
  if (!voice) return;

  // [AUDIT-M12] size check
  if (voice.file_size && voice.file_size > env.MAX_VOICE_SIZE_MB * 1024 * 1024) {
    await ctx.reply(ctx.t('voice.too_large', { limit: env.MAX_VOICE_SIZE_MB }));
    return;
  }

  // Rate limit (счётчик инкрементится даже при ошибке Whisper — [AUDIT-H7])
  const rl = await ctx.services.rateLimit.checkAndIncrement(ctx.user!.id, 'voice');
  if (!rl.allowed) {
    await ctx.reply(ctx.t('rate_limit.voice', { hours: Math.ceil(rl.resetsInSec / 3600) }));
    return;
  }

  // Download
  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const audioBytes = new Uint8Array(await response.arrayBuffer());

  // Transcribe
  const result = await ctx.services.voice.transcribe(audioBytes, ctx.lang);
  if (!result.ok) {
    await ctx.reply(ctx.t('error.voice_failed'));
    return;  // [AUDIT-H7] rate limit slot УЖЕ списан, не откатываем
  }

  await ctx.reply(`📝 ${result.value}`, {
    reply_parameters: { message_id: ctx.message!.message_id },
  });

  // Track voice in usage stats
  await ctx.services.cost.trackRequest({
    userId: ctx.user!.id, kind: 'voice', tokensInput: 0, tokensOutput: 0
  });

  // Pass through text pipeline (override text)
  await handleTextMessageWithText(ctx, result.value);
}
```

### 8.4 Document upload [AUDIT-C8, M10]

```typescript
export async function handleDocumentUpload(ctx: MyContext): Promise<void> {
  const user = ctx.user!;
  const doc = ctx.message!.document!;

  const rl = await ctx.services.rateLimit.checkAndIncrement(user.id, 'document');
  if (!rl.allowed) {
    await ctx.reply(ctx.t('rate_limit.document', { hours: Math.ceil(rl.resetsInSec / 3600) }));
    return;
  }

  if (doc.file_size && doc.file_size > env.MAX_DOCUMENT_SIZE_MB * 1024 * 1024) {
    await ctx.reply(ctx.t('document.too_large', { limit: env.MAX_DOCUMENT_SIZE_MB }));
    return;
  }

  if (!SUPPORTED_MIME_TYPES.includes(doc.mime_type as never)) {
    await ctx.reply(ctx.t('document.unsupported'));
    return;
  }

  const file = await ctx.getFile();
  const fileBytes = new Uint8Array(await (await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`
  )).arrayBuffer());

  const extracted = await ctx.services.document.extractText({
    fileBytes, mimeType: doc.mime_type!, maxSizeMb: env.MAX_DOCUMENT_SIZE_MB,
  });
  if (!extracted.ok) {
    await ctx.reply(ctx.t(`document.${extracted.error.kind}`));
    return;
  }

  if (extracted.value.tokensEstimate > env.DOCUMENT_MAX_TOKENS) {
    await ctx.reply(ctx.t('document.too_long'));
    return;
  }

  // [AUDIT-M10] Moderate first 50K chars (известное ограничение)
  const modResult = await ctx.services.moderation.checkInput(
    extracted.value.text.slice(0, 50_000), user.id, ctx.lang
  );
  if (modResult.decision === 'block') {
    await ctx.reply(ctx.t('moderation.document_blocked'));
    return;
  }

  // [AUDIT-C8, N4] Заменяет активный контекст. Транзакционно через startNew.
  const conv = await ctx.services.conversation.startNew(user.id);
  await ctx.services.conversation.attachDocument({
    conversationId: conv.id,
    text: extracted.value.text,
    documentName: doc.file_name ?? 'document',
    tokens: extracted.value.tokensEstimate,
  });

  // [AUDIT-C8] Явно предупреждаем что контекст заменён
  await ctx.reply(ctx.t('document.replaced_context', {
    pages: extracted.value.pages,
    tokens: extracted.value.tokensEstimate,
  }));

  await ctx.services.cost.trackRequest({
    userId: user.id, kind: 'document', tokensInput: 0, tokensOutput: 0,
  });
}
```

### 8.5 Выбор персонажа [AUDIT-M8]

```typescript
export async function handlePersonaCommand(ctx: MyContext): Promise<void> {
  const personas = await ctx.services.persona.listActive();
  await ctx.reply(ctx.t('persona.choose'), {
    reply_markup: buildPersonaKeyboard(personas, ctx.lang),
  });
}

export async function handlePersonaCallback(ctx: MyContext): Promise<void> {
  const data = ctx.callbackQuery!.data!;
  const slug = data.split(':')[1] as PersonaSlug;
  const chosen = await ctx.services.persona.getBySlug(slug);
  if (!chosen) {
    await ctx.answerCallbackQuery({ text: 'Not found' });
    return;
  }

  // [AUDIT-M8, N4] startNew транзакционно деактивирует старые DM-conversations
  const conv = await ctx.services.conversation.startNew(ctx.user!.id, { personaId: chosen.id });
  await ctx.services.users.update(ctx.user!.id, {
    activePersonaId: chosen.id,
    activeConversationId: conv.id,
  });

  await ctx.editMessageText(ctx.t('persona.selected', { name: ctx.t(chosen.nameKey) }));
  await ctx.answerCallbackQuery();
}
```

### 8.6 Group @mention (single-turn) [AUDIT-C9, N2, N3, P5, X12]

**Privacy mode = ON в BotFather.** Бот получает только: сообщения с `@bot_username`, прямые `/команды`, reply на сообщения бота **если в reply есть @mention**.

**MVP: каждое @mention = single-turn**, без истории. Reply-thread в группах — Phase 2 ([BACKLOG.md](BACKLOG.md)).

```typescript
export async function handleGroupMention(ctx: MyContext): Promise<void> {
  const user = ctx.user;
  if (!user?.tosAcceptedAt) {
    await ctx.reply(ctx.t('group.must_start_dm_first', {
      botLink: `https://t.me/${env.BOT_USERNAME}`,
    }), { reply_parameters: { message_id: ctx.message!.message_id } });
    return;
  }

  // [AUDIT-X12] extract без @mention, с offset==0 для commands
  const text = extractTextWithoutMention(ctx.message!, env.BOT_USERNAME);
  if (!text || text.length < 2) return;

  const rl = await ctx.services.rateLimit.checkAndIncrement(user.id, 'text');
  if (!rl.allowed) {
    await ctx.reply(ctx.t('rate_limit.text', { /*...*/ }), {
      reply_parameters: { message_id: ctx.message!.message_id },
    });
    return;
  }

  const modIn = await ctx.services.moderation.checkInput(text, user.id, ctx.lang);
  if (modIn.decision === 'block') {
    await ctx.reply(ctx.t('moderation.input_blocked'), {
      reply_parameters: { message_id: ctx.message!.message_id },
    });
    return;
  }

  // Single-turn: minimal messages (system + 1 user)
  const defaultPersona = await ctx.services.persona.getDefault();
  const systemPrompt = ctx.services.persona.renderSystemPrompt({
    persona: defaultPersona,
    userLang: ctx.lang,
  });
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text },
  ];

  // [AUDIT-N2] sink с replyToMessageId — commit будет ctx.reply с reply_parameters
  const sink = createTypingIndicatorSink({
    ctx,
    replyToMessageId: ctx.message!.message_id,
  });
  let accumulated = '';
  let finalUsage: { tokensInput: number; tokensOutput: number } | null = null;

  try {
    for await (const chunk of ctx.services.gonka.chatStream({ messages: llmMessages })) {
      accumulated += chunk.delta;
      await sink.push(chunk.delta);
      if (chunk.done && chunk.tokensInput != null && chunk.tokensOutput != null) {
        finalUsage = { tokensInput: chunk.tokensInput, tokensOutput: chunk.tokensOutput };
      }
    }
  } catch (err) {
    await sink.abort();
    ctx.logger.error({ err }, 'Group streaming failed');
    return;
  }

  const modOut = await ctx.services.moderation.checkOutput(accumulated, user.id, ctx.lang);
  if (modOut.decision === 'block') {
    await sink.abort();
    await ctx.reply(ctx.t('moderation.output_blocked'), {
      reply_parameters: { message_id: ctx.message!.message_id },
    });
    return;
  }

  await sink.commit(accumulated);
  // [AUDIT-N3] НИ voice output, НИ persistent conversation в группах

  if (finalUsage) {
    await ctx.services.cost.trackRequest({
      userId: user.id, kind: 'text',
      tokensInput: finalUsage.tokensInput, tokensOutput: finalUsage.tokensOutput,
    });
  }
}
```

**[AUDIT-X12] `extractTextWithoutMention`** — entity-based, command вырезается только если в начале:

```typescript
function extractTextWithoutMention(msg: Message, botUsername: string): string {
  const entities = msg.entities ?? [];
  let text = msg.text ?? '';
  for (const e of [...entities].reverse()) {
    const slice = text.slice(e.offset, e.offset + e.length);
    if (e.type === 'mention' && slice.toLowerCase() === `@${botUsername.toLowerCase()}`) {
      text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
    } else if (e.type === 'bot_command' && e.offset === 0) {
      // Только команда в начале — типа /help. Команды внутри текста сохраняем.
      text = text.slice(e.offset + e.length);
    }
  }
  return text.trim();
}
```

### 8.7 `/new` [AUDIT-X8, N4]

```typescript
export async function handleNew(ctx: MyContext): Promise<void> {
  const user = ctx.user!;
  // [AUDIT-N4] startNew сама делает deactivate + insert в транзакции.
  // Отдельный вызов deactivateAllForUser не нужен.
  const newConv = await ctx.services.conversation.startNew(user.id, {
    personaId: user.activePersonaId ?? undefined,
  });
  await ctx.services.users.update(user.id, { activeConversationId: newConv.id });
  await ctx.reply(ctx.t('new_conversation.confirmed'));
}
```

### 8.8 `/report` [AUDIT-H8, M17, X7]

```typescript
export async function handleReport(ctx: MyContext): Promise<void> {
  const user = ctx.user!;
  let targetMessageId: MessageId | null = null;

  // 1. Reply на сообщение бота
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.id === ctx.me.id) {
    targetMessageId = await ctx.services.conversation.findMessageByTgId(user.id, replyTo.message_id);
  }
  // 2. Иначе — последний assistant в активной conversation
  if (!targetMessageId) {
    targetMessageId = await ctx.services.conversation.lastAssistantMessage(user.id);
  }

  if (!targetMessageId) {
    await ctx.reply(ctx.t('report.nothing_to_report'));
    return;
  }

  const reason = ctx.message?.text?.replace(/^\/report\s*/, '').trim() || 'user_flag';
  await ctx.services.userReports.create({
    reporterUserId: user.id, messageId: targetMessageId, reason,
  });

  await ctx.api.sendMessage(env.ADMIN_CHAT_ID,
    `⚠️ Report: messageId=${targetMessageId} from userId=${user.id} reason=${reason}`);
  await ctx.reply(ctx.t('report.thanks'));
}
```

**[AUDIT-M17]** Report — только через команду `/report`, не через inline-кнопку (отказались для чистоты UX).

### 8.9 `/delete_my_data` [AUDIT-A1, B3]

```typescript
export async function handleDeleteMyData(ctx: MyContext): Promise<void> {
  await ctx.reply(ctx.t('delete.confirm'), {
    reply_markup: {
      inline_keyboard: [[
        { text: ctx.t('delete.yes_delete'), callback_data: 'delete:confirm' },
        { text: ctx.t('delete.cancel'),  callback_data: 'delete:cancel' },
      ]],
    },
  });
}

export async function handleDeleteCallback(ctx: MyContext): Promise<void> {
  if (ctx.callbackQuery!.data === 'delete:cancel') {
    await ctx.editMessageText(ctx.t('delete.cancelled'));
    return;
  }
  const user = ctx.user!;
  // [AUDIT-B3] anonymize audit_log (security exemption), delete остальное cascade
  await ctx.services.users.deleteCascade(user.id);
  await ctx.editMessageText(ctx.t('delete.done'));
  ctx.logger.info({ tgId: ctx.from!.id }, 'User data deleted (GDPR)');
}
```

---

## 9. Внешние интеграции

### 9.1 mingles.ai → Gonka

**Endpoint:** `POST https://gateway.mingles.ai/v1/chat/completions`
**Auth:** `Authorization: Bearer {GONKA_API_KEY}`
**Стандарт:** OpenAI-compatible.

```http
POST /v1/chat/completions
Authorization: Bearer sk-...
Content-Type: application/json

{
  "model": "Kimi-K2.6",
  "messages": [...],
  "max_tokens": 4096,
  "temperature": 0.7,
  "stream": true
}
```

**SSE response:**
```
data: {"choices":[{"delta":{"role":"assistant"}}]}
data: {"choices":[{"delta":{"content":"Прив"}}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":7}}
data: [DONE]
```

**Tokens & cost [AUDIT-L13]:** считаем по `usage` в финальном чанке. Если отсутствует — fallback на `js-tiktoken` estimate + `logger.warn({ usageDegraded: true })`. Cost считается всё равно (по оценке), просто менее точно.

**Ошибки:**
- `429` → retry с backoff
- `5xx` → retry 1 раз, fallback "service unavailable"
- timeout → `t('error.service_unavailable')`
- `4xx` (кроме 429) → НЕ ретраим

### 9.2 OpenAI Moderation

**Endpoint:** `POST https://api.openai.com/v1/moderations`. Бесплатно.

```typescript
const response = await openai.moderations.create({
  model: 'omni-moderation-latest',
  input: text,
});
const r = response.results[0];
if (!r) throw new Error('Empty moderation response');
// Маппинг внутренних категорий — см. §6.2 OPENAI_TO_INTERNAL_CATEGORY
```

### 9.3 OpenAI Whisper

```typescript
import OpenAI, { toFile } from 'openai';

const response = await openai.audio.transcriptions.create({
  file: await toFile(audioBytes, 'audio.ogg', { type: 'audio/ogg' }),
  model: env.OPENAI_WHISPER_MODEL,
  language,                             // ISO 639-1
});
return response.text;
```

### 9.4 Edge-TTS + ffmpeg → OGG/Opus [AUDIT-H1, P2]

**Telegram `sendVoice` принимает ТОЛЬКО OGG/Opus.** Edge-TTS отдаёт MP3 — конвертируем.

```typescript
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { mp3ToOggOpus } from '../utils/ffmpeg';

async function synthesize(text: string, language: string): Promise<Uint8Array> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(
    VOICE_MAP[language as keyof typeof VOICE_MAP] ?? VOICE_MAP.en,
    OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
  );
  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream) chunks.push(chunk as Buffer);
  const mp3 = new Uint8Array(Buffer.concat(chunks));
  return await mp3ToOggOpus(mp3);
}
```

---

## 10. Content Safety pipeline

### 10.1 Input pipeline [AUDIT-P3]

Имена категорий ниже — **internal** (после маппинга). См. §6.2 OPENAI_TO_INTERNAL_CATEGORY.

```
[user text]
   │
   ▼
[regex blacklist]            → block, severity=low, audit, flag++
   │
   ▼
[jailbreak detector]         → block, severity=high, audit('jailbreak_attempt'), flag++
   │
   ▼
[OpenAI Moderation API]
   │
   ├─ sexualMinors ≥ 0.2     → block, severity=critical, INSTANT permaban + admin alert [AUDIT-H11]
   │                              (БЕЗ инкремента flag_count)
   ├─ harm ≥ 0.6             → block, severity=high, flag++
   ├─ violence ≥ 0.7         → block, severity=high, flag++
   ├─ hate ≥ 0.6             → block, severity=high, flag++
   ├─ selfHarm ≥ 0.5         → block, severity=high + t('self_harm.resources'), flag++
   ├─ sexual ≥ 0.7           → block, severity=medium, flag++
   │
   └─ none                   → allow
       │
       ▼
   [pass to LLM]
```

### 10.2 Output pipeline [AUDIT-C7, P1]

То же на ответ модели. **Critical [AUDIT-C7]:** output moderation выполняется на накопленном тексте **до** показа юзеру. Streaming шёл в hidden buffer (typing-индикатор §6.1b), юзер ещё ничего не видел. Если flagged — `sink.abort()`, юзеру отдаём `t('moderation.output_blocked')`.

`sexualMinors` в output модели = особенно тревожно. Triggers admin alert + audit + НЕ показ. (Output блок при sexualMinors **не** триггерит permaban юзера — это могла быть проблема модели, не юзера.)

### 10.3 User reputation [AUDIT-P4]

Каждый flagged input → `incrementFlagCount` (§6.2 SQL). Атомарно в одной транзакции:
- lazy reset: если `flag_count_week_reset_at < NOW() - 7 days` → reset to 1
- иначе → +1
- `flag_count_total` += 1
- если `flag_count_week ≥ USER_BAN_FLAG_THRESHOLD` → `banned_until = NOW() + 24h`
- если `flag_count_total ≥ USER_PERMABAN_FLAG_THRESHOLD` → `bannedPermanent = true`

**`sexualMinors` — отдельный путь:** мгновенный `bannedPermanent = true` + admin alert + audit, **без инкремента** flag_count (категория = автоматическая critical, не часть rate-limited reputation).

### 10.4 Audit log

```typescript
await auditLog.create({
  userId: user.id,
  eventType: 'flag_input',          // или 'jailbreak_attempt', 'sexual_minors_detected', etc.
  severity: 'high',
  contentHash: sha256(text),
  contentExcerpt: text.slice(0, 200),
  categories: r.categories,
  moderationScores: r.category_scores,
  metadata: {
    personaId: conv?.personaId ?? null,
    lang: user.languageCode,
    doc_moderated_prefix_only: false,  // true только для документов [AUDIT-M10]
  },
});
```

**Retention:** 30 дней (GDPR) — cron в 03:00 UTC (см. §12.4).

---

## 11. Rate limiting и cost tracking

### 11.1 Rate limiter [AUDIT-H4]

Keys: `rl:${kind}:${userId}:${YYYY-MM-DD}`.

```typescript
async function checkAndIncrement(userId, kind): Promise<RateLimitResult> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:${kind}:${userId}:${today}`;
  const limit = limits[kind];

  const results = await redis.multi().incr(key).expire(key, 86_400).exec();
  if (!results) throw new Error('Redis pipeline failed');
  const current = results[0]?.[1] as number;

  if (current > limit) {
    const ttl = await redis.ttl(key);
    return { allowed: false, current, limit, resetsInSec: ttl };
  }
  return { allowed: true, current, limit, resetsInSec: 86_400 };
}
```

**[AUDIT-H4]** Счётчик инкрементируется **включая** rejected requests — защита от /spam. Документировано.

### 11.2 Cost tracker [AUDIT-X14, X15, H5]

```typescript
async function trackRequest(opts): Promise<CostTrackingResult> {
  const cost =
    opts.tokensInput * config.costPerInputToken +
    opts.tokensOutput * config.costPerOutputToken;
  const today = new Date().toISOString().slice(0, 10);

  // [AUDIT-X14] kind-dispatched counter
  const incField =
    opts.kind === 'voice' ? 'voiceMessages' :
    opts.kind === 'document' ? 'documents' : 'textMessages';

  await db.insert(usageStatsDaily).values({
    date: today,
    userId: opts.userId,
    [incField]: 1,
    tokensInput: opts.tokensInput,
    tokensOutput: opts.tokensOutput,
    costUsd: cost.toString(),
  }).onConflictDoUpdate({
    target: [usageStatsDaily.date, usageStatsDaily.userId],
    set: {
      [incField]: sql`${usageStatsDaily[incField]} + 1`,
      tokensInput: sql`${usageStatsDaily.tokensInput} + ${opts.tokensInput}`,
      tokensOutput: sql`${usageStatsDaily.tokensOutput} + ${opts.tokensOutput}`,
      costUsd: sql`${usageStatsDaily.costUsd} + ${cost}`,
    },
  });

  // Aggregate daily total in Redis
  const dailyKey = `cost:daily:${today}`;
  const total = await redis.incrbyfloat(dailyKey, cost);
  await redis.expire(dailyKey, 86_400 + 3600);
  const dailyTotal = parseFloat(total);

  const overAlert = dailyTotal > config.alertThresholdUsd;
  const overKill = dailyTotal > config.dailyBudgetUsd;

  // [AUDIT-H5] атомарная дедупликация алертов через SET NX EX
  if (overAlert) {
    const lockAcquired = await redis.set(`cost:alerted:${today}`, '1', 'NX', 'EX', 86_400);
    if (lockAcquired === 'OK') {
      // [AUDIT-X15] явный inject deps.bot
      await deps.bot.api.sendMessage(config.adminChatId,
        `⚠️ Daily cost: $${dailyTotal.toFixed(2)}`);
    }
  }

  if (overKill) {
    await redis.set('kill_switch', '1', 'EX', 86_400);
    await deps.bot.api.sendMessage(config.adminChatId,
      `🚨 KILL SWITCH: $${dailyTotal.toFixed(2)} > $${config.dailyBudgetUsd}`);
  }

  return { dailyTotalUsd: dailyTotal, overAlertThreshold: overAlert, overKillThreshold: overKill };
}
```

### 11.3 Kill switch middleware

```typescript
export const killSwitchMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  if (env.ADMIN_TG_IDS.includes(ctx.from?.id ?? 0)) return next();

  const killActive = (await redis.get('kill_switch')) === '1' || env.KILL_SWITCH;
  if (killActive) {
    await ctx.reply(ctx.t('error.maintenance'));
    return;
  }
  return next();
};
```

---

## 12. Логирование, мониторинг, cron

### 12.1 Pino + traceId [AUDIT-L12, M3, B4]

В Docker — **только JSON**. В local dev — pipe `pnpm dev | pino-pretty` (см. scripts).

```typescript
// src/utils/logger.ts
import pino from 'pino';
import { randomUUID } from 'node:crypto';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'gonka-bot' },
});

export type Logger = typeof logger;

export function createRequestLogger(parent: Logger): { logger: Logger; traceId: string } {
  const traceId = randomUUID();
  return { logger: parent.child({ traceId }), traceId };
}
```

**Logging middleware:**

```typescript
export const loggingMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  const { logger: reqLogger, traceId } = createRequestLogger(logger);
  ctx.logger = reqLogger.child({
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
  } catch (err) {
    ctx.logger.error({ err, durationMs: Date.now() - start }, 'update_failed');
    throw err;
  }
};
```

Каждый log entry:
```json
{
  "level": 30, "time": ..., "service": "gonka-bot",
  "traceId": "a1b2c3...", "tgUserId": 678910, "chatId": ..., "chatType": "private",
  "event": "llm_request", "userId": 12345, "personaSlug": "analyst",
  "tokensInput": 320, "tokensOutput": 178, "costUsd": 0.00031,
  "latencyMs": 2340, "lang": "ru", "usageDegraded": false
}
```

### 12.2 Метрики

MVP: **Better Stack** ($25/мес) ИЛИ **Grafana + Prometheus** (self-host). Решить на старте Недели 7A.

Ключевые: DAU, WAU, msgs/day (text/voice/doc), avg latency Gonka, error rate Gonka, daily cost, flag rate, per-language.

### 12.3 Алерты

- Daily cost > $30 → admin chat
- Daily cost > $50 → kill switch + admin chat
- Gonka error rate > 5% / 5 мин → admin chat
- Любой `severity=critical` audit → admin chat немедленно

### 12.4 Cron jobs [AUDIT-L11, B1]

`services/crons.ts`, регистрируются в `main.ts` после bootstrap:

```typescript
import cron from 'node-cron';

export function registerCrons(deps: { db; logger; }): void {
  // 1. Audit log cleanup — раз в сутки 03:00 UTC. GDPR retention 30 дней.
  cron.schedule('0 3 * * *', async () => {
    deps.logger.info('Cron: audit log cleanup');
    await deps.db.execute(sql`
      DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '30 days'
    `);
  }, { timezone: 'UTC' });

  // [AUDIT-B1] resetDailyFlags убран — Redis TTL делает всё.
  // Postgres backup — host crontab (см. §13.5), не node-cron.
}
```

---

## 13. Deployment

### 13.0 Dockerfile [AUDIT-H1, M5]

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runtime
WORKDIR /app

# [AUDIT-H1] ffmpeg для конвертации MP3 → OGG/Opus
RUN apk add --no-cache ffmpeg

RUN addgroup -g 1001 nodejs && adduser -S nodeapp -u 1001 -G nodejs

COPY --from=builder --chown=nodeapp:nodejs /app/dist ./dist
COPY --from=builder --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodeapp:nodejs /app/package.json ./
COPY --from=builder --chown=nodeapp:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nodeapp:nodejs /app/src/data ./src/data
COPY --from=builder --chown=nodeapp:nodejs /app/src/locales ./src/locales

USER nodeapp
EXPOSE 8080

# [AUDIT-L10] /ready — проверяет DB + Redis
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8080/ready || exit 1

# [AUDIT-M5] Auto-migrate + seed personas + start
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/seed-personas.js && node dist/main.js"]
```

### 13.1 docker-compose.yml [AUDIT-L1]

```yaml
# [AUDIT-L1] version directive removed (Compose v2)
services:
  bot:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      - DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_started }
    networks: [internal]

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      retries: 5
    networks: [internal]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes: [redis_data:/data]
    networks: [internal]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [bot]
    networks: [internal]

volumes: { pg_data: {}, redis_data: {}, caddy_data: {}, caddy_config: {} }
networks: { internal: {} }
```

### 13.2 Caddyfile [AUDIT-C10, L8]

```
bot.yourdomain.com {
    reverse_proxy bot:8080 {
        # [AUDIT-C10] Явно пробрасываем secret token header
        header_up X-Telegram-Bot-Api-Secret-Token {http.request.header.X-Telegram-Bot-Api-Secret-Token}
    }
    encode gzip
    # [AUDIT-L8] Security headers
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options    "nosniff"
        Referrer-Policy           "strict-origin-when-cross-origin"
    }
    log {
        output stdout
        format json
    }
}
```

### 13.3 Шаги развёртывания

```bash
# Ubuntu 24.04 VPS (Hetzner CPX21)
curl -fsSL https://get.docker.com | sh
sudo apt install -y docker-compose-plugin

git clone <repo> && cd gonka-bot
cp .env.example .env && nano .env

docker compose up -d
# Auto: migrate + seed + start (Dockerfile CMD)

docker compose exec bot node dist/scripts/set-webhook.js
curl https://bot.yourdomain.com/health    # liveness
curl https://bot.yourdomain.com/ready     # readiness
```

### 13.4 BotFather setup

```
/newbot
<bot name>
<bot username>

/setdescription
/setabouttext
/setuserpic
/setcommands
start - 🚀 Начать
help - ℹ️ Помощь
new - 🆕 Новый диалог
persona - 🎭 Сменить персонажа
voice - 🎙 Голосовые ответы
lang - 🌐 Язык интерфейса
about - 💚 О боте
report - ⚠️ Сообщить о проблеме
delete_my_data - 🗑 Удалить мои данные

/setjoingroups Enable
/setprivacy    Enable      # [AUDIT-C9] КРИТИЧНО
/setinline     Disable
```

### 13.5 Backup [AUDIT-M6]

Host crontab (`crontab -e`):

```cron
# Daily pg_dump в 04:00 UTC, retention 14 дней
0 4 * * * docker exec gonka-bot-postgres-1 pg_dump -U gonka gonka_bot | gzip > /var/backups/gonka/dump_$(date +\%F).sql.gz && find /var/backups/gonka -name 'dump_*.sql.gz' -mtime +14 -delete
```

Перед использованием: `mkdir -p /var/backups/gonka && chown root:root /var/backups/gonka`.

---

## 14. Тестирование

### 14.1 Unit-тесты (vitest) [AUDIT-L17]

Минимум для MVP:
- `tests/unit/services/moderation.test.ts` — pipeline (20 harmful + 20 safe prompts), маппинг категорий, sexualMinors instant permaban, increment + ban thresholds (mock users repo)
- `tests/unit/services/jailbreak.test.ts` — все паттерны
- `tests/unit/services/rate-limiter.test.ts` — INCR+EXPIRE, граничные значения (через `ioredis-mock`)
- `tests/unit/services/cost-tracker.test.ts` — расчёт, NX EX дедупликация, kill switch
- `tests/unit/services/conversation.test.ts` — trim парами, getMessagesForLlm token reservation, document_overflow error
- `tests/unit/services/document.test.ts` — fixtures: small.pdf, table.docx, sample.txt
- `tests/unit/utils/telegram-split.test.ts` — split в местах перевода строк/абзацев
- `tests/unit/utils/ffmpeg.test.ts` — конвертация (требует ffmpeg в CI)

### `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // [AUDIT-L17] минимальные пороги
      thresholds: {
        global: { lines: 70, branches: 60 },
      },
    },
  },
});
```

### 14.2 Integration-тесты [AUDIT-A8]

Через `@testcontainers/postgresql` + `@testcontainers/redis` (реальные Postgres+Redis):
- `tests/integration/chat-flow.test.ts` — webhook → DB запись (mock Gonka SSE, mock OpenAI)
- `tests/integration/voice-flow.test.ts`
- `tests/integration/document-flow.test.ts`
- `tests/integration/tos-flow.test.ts` — /start → ToS → age gate → welcome
- `tests/integration/webhook-secret.test.ts` — **POST /webhook без secret → 401** [AUDIT-C10]
- `tests/integration/conversation-race.test.ts` — параллельный /new + getOrCreateActive — нет unique violation [AUDIT-N4]
- `tests/integration/moderation-permaban.test.ts` — sexualMinors → instant permaban в БД [AUDIT-H11]

### 14.3 Manual QA checklist [AUDIT-P5, M14]

- [ ] Бот отвечает в DM (typing-индикатор → финальный текст)
- [ ] Voice input на 6 языках (EN/RU обязательно, остальные spot-check)
- [ ] PDF 50 страниц извлекается, помещается в 256K
- [ ] DOCX извлекается
- [ ] @mention в группе работает (single-turn)
- [ ] **Reply на сообщение бота в группе — НЕ продолжает контекст** (single-turn в MVP) [AUDIT-P5]
- [ ] Все 10 персонажей переключаются, тон ответов меняется
- [ ] Rate limit text: 31-е сообщение → блок
- [ ] Rate limit voice: 6-е голосовое → блок
- [ ] Rate limit document: 4-й документ → блок
- [ ] Document > 10MB → "too large"
- [ ] Document > DOCUMENT_MAX_TOKENS → "too long"
- [ ] Moderation: 20 harmful промптов (test fixture) — все блокируются
- [ ] Jailbreak: "ignore previous instructions" — блок + audit
- [ ] **sexualMinors → instant permaban + admin alert** [AUDIT-H11]
- [ ] ToS показывается при первом /start, age gate после
- [ ] **Age gate: No → /start через час — снова блок (30 дней)** [AUDIT-H9]
- [ ] **ToS bump: меняем env, юзер /start → пере-acceptит** [AUDIT-H10]
- [ ] /new — сброс контекста, /persona — переключение + новая conversation
- [ ] /report (с reply на бота) — запись + admin notification
- [ ] /report (без reply) — берёт последний assistant
- [ ] /delete_my_data → confirm → user удалён, audit_log anonymized
- [ ] /kill от админа → бот в maintenance, /unkill снимает
- [ ] Daily budget exceed → auto kill switch
- [ ] Webhook secret wrong → 401 (curl-тест) [AUDIT-C10]
- [ ] **Полный флоу пройден в каждой из 6 локалей, RTL для AR корректен** [AUDIT-M14]
- [ ] Voice output: `/voice on` → ответ голосом (OGG/Opus, не MP3)
- [ ] **Voice output отключён в группах** [AUDIT-N3]
- [ ] Логи: JSON, с traceId, userId, costUsd
- [ ] Длинный ответ (>4000 chars) — split на части корректно [AUDIT-A4]

---

## 15. Фазированный план реализации

### Неделя 1: Foundation

**Цель:** Локалка работает, `/start` отвечает "Hello", health/ready endpoints, тесты+линт+билд.

- Setup проекта: `package.json` (type=module, scripts), `tsconfig.json` (strict), `biome.json`, `vitest.config.ts`
- Docker Compose: postgres + redis + bot + caddy
- Dockerfile multi-stage с ffmpeg [AUDIT-H1]
- grammY + Hono setup, webhook через ngrok (local) или long-polling (`bot.start()`)
- Drizzle schema (§5) + relations (§5) + первая миграция
- **Partial unique index** — ручная миграция [AUDIT-M11, N4]
- `/start` handler → "Hello, world!" (заглушка, без ToS)
- pino + structured logs + traceId middleware [AUDIT-L12]
- `/health` (liveness) + `/ready` (DB+Redis ping) [AUDIT-L10]
- README с quick start [AUDIT-L9]
- husky + lint-staged: biome на pre-commit, tsc на pre-push

**Acceptance:**
- `curl /health` → 200
- `curl /ready` → 200 при поднятом стеке, 503 без БД
- `/start` отвечает в TG
- `pnpm test`, `pnpm lint`, `pnpm build` зелёные
- Drizzle Studio показывает таблицы

### Неделя 2: Core chat + streaming

**Цель:** Юзер шлёт текст → typing-индикатор → ответ Kimi, 5+ ходов контекста.

- `GonkaClient` с SSE через `eventsource-parser` [AUDIT-H2]
- Получить API key от mingles.ai, smoke test
- `Tokenizer` (js-tiktoken wrapper) [AUDIT-X3]
- `ConversationService`: getOrCreateActive, startNew (транзакционно [AUDIT-N4]), appendMessage с tgMessageId [AUDIT-X13], getMessagesForLlm с reservation [AUDIT-A5]
- `users.ts` repo + service (без deleteCascade)
- `bot/context.ts` MyContext с tokenizer, logger, traceId [AUDIT-X4, X9]
- Middleware order [AUDIT-X10]: logging → services → i18n → auth → kill-switch
- `composers/chat.ts` (см. §8.2)
- `streaming-sink.ts`: TypingIndicatorSink [AUDIT-C1, C7]
- `/new` команда [AUDIT-X8]
- `/help` (реальный текст)
- RateLimiter [AUDIT-H4] + интеграция в chat
- `splitForTelegram` utility [AUDIT-A4]
- `chatComplete` сразу реализован [AUDIT-M13] (use в Phase 1.1 для auto-title)
- I18n stub: en.json + ru.json (минимальные ключи)

**Acceptance:** EN/RU streaming работает, контекст 5+ ходов, 31-е сообщение → rate limit, длинные ответы сплитятся.

### Неделя 3: Voice + persona

**Цель:** Voice in/out на EN/RU, 10 персонажей переключаются.

- `VoiceService`: Whisper transcribe + Edge-TTS synthesize + ffmpeg [AUDIT-H1, L6]
- `mp3ToOggOpus` utility (§6.4)
- `composers/voice.ts`: voice message + `/voice` toggle [AUDIT-M12, H7, N3]
- `PersonaService` + `personas` repo
- `data/personas.yaml` — все 10 (Приложение A)
- `scripts/seed-personas.ts` (upsert по slug на startup) [AUDIT-L18]
- `composers/persona.ts`: `/persona` + callbacks [AUDIT-M8, N4]
- Switching persona = новая conversation (через startNew)
- `renderSystemPrompt` с `ALWAYS respond in: {userLang}` [AUDIT-L14]

**Acceptance:** Voice EN/RU работает; `/voice on` → OGG ответ; персонажи меняют тон.

### Неделя 4: Documents + long context

**Цель:** PDF 30 страниц → бот отвечает по содержимому, 256K используется.

- `DocumentService`: unpdf + mammoth + TXT [AUDIT-L7]
- `composers/document.ts`: upload → extract → attach → ack [AUDIT-C8, M10]
- Token reservation в `getMessagesForLlm` [AUDIT-A5]
- Document moderation первых 50K + metadata flag [AUDIT-M10]
- Test fixtures: small.pdf, big.pdf (30 pages), table.docx, sample.txt
- `document_overflow` Err handling в chat.ts

**Acceptance:** PDF 30 страниц — "got it, 30 pages"; вопрос по содержимому → правильный ответ; PDF > 10MB → "too large"; PDF > DOCUMENT_MAX_TOKENS → "too long".

### Неделя 5: All personas + groups

**Цель:** 6 локалей готовы, групповой single-turn работает.

- Локали: es.json, ar.json, zh.json, de.json (полный набор ключей)
- Имена/описания 10 персонажей в 6 локалях
- `composers/group.ts`: handleGroupMention single-turn [AUDIT-C9, N2, N3, X12]
- `composers/about.ts`: DM + group
- `composers/lang.ts`: `/lang` inline keyboard
- `extractTextWithoutMention` через entities [AUDIT-M7, X12]
- BotFather: `/setprivacy Enable`, `/setjoingroups Enable`
- **НЕ** реализовываем reply-thread в группах [AUDIT-P5]

**Acceptance:** Все 6 локалей рендерятся (включая AR RTL); в группе `@bot привет` → ответ; reply на бота в группе **не** продолжает контекст (single-turn).

### Неделя 6: Content safety + reputation

**Цель:** Moderation на input+output, ban-логика, `/report`.

- `JailbreakDetector` (regex)
- `BlacklistChecker` + LDNOOBW списки в `data/blacklist/`
- `ModerationService`: OpenAI + thresholds + mapping [AUDIT-H12]
- `incrementFlagCount` транзакционно с ban-thresholds [AUDIT-N1, N5]
- `sexualMinors` instant permaban [AUDIT-H11]
- Output moderation в chat.ts и group.ts (после streaming, до показа) [AUDIT-C7]
- `auditLog` repo + integration
- `composers/report.ts` [AUDIT-H8, X7]
- `composers/admin.ts`: `/kill`, `/unkill`, `/stats`
- `users.deleteCascade` с anonymize audit_log [AUDIT-A1, B3]
- `composers/delete-data.ts` + двухшаговое подтверждение

**Acceptance:** 20 harmful промптов блокируются; jailbreak → audit; 3 flags/неделя → 24h ban; sexualMinors → permaban + admin alert; /report работает с reply и без.

### Неделя 7A: Polish + ToS + cost + monitoring [AUDIT-A10]

**Цель:** ToS/age gate, cost cap, kill switch, мониторинг настроен.

- `composers/start.ts`: ToS flow [AUDIT-H10], age gate [AUDIT-H9]
- `tos.ts` keyboard
- `CostTracker` с per-kind tracking [AUDIT-X14, X15] и атомарной дедупликацией [AUDIT-H5]
- `kill-switch` middleware
- `node-cron` registration: audit cleanup [AUDIT-L11]
- Better Stack ИЛИ Grafana setup (выбрать)
- Admin chat alerts: cost > $30, cost > $50 (auto-kill), critical audit events
- Manual QA по чек-листу §14.3 (внутри team, не на проде)

**Acceptance:** Все пункты §14.3 проходят локально; admin alerts работают (через test trigger).

### Неделя 7B: Deploy + soft launch [AUDIT-A10]

**Цель:** Production deploy, 50-100 первых юзеров.

- VPS provisioning + Docker install
- DNS + Caddy auto-HTTPS
- `.env` заполнен production-ключами
- `docker compose up -d`
- Webhook регистрация
- BotFather: commands, descriptions, privacy ON
- pg_dump host cron [AUDIT-M6]
- Webhook secret test: curl без секрета → 401
- Smoke test всех команд на prod
- Backup test: восстановление из dump на staging
- Soft launch: 50-100 юзеров через личные каналы
- Мониторинг первых 48 часов

**Acceptance:** Бот на prod-домене с HTTPS; мониторинг показывает живые метрики; 50+ юзеров без блокеров за 24 часа; кост в норме.

---

## 16. Acceptance criteria для MVP

### Функциональность
1. ✅ /start с ToS versioning + age gate с rejection block 30d, 6 языков
2. ✅ Text chat: typing-indicator → output moderation → финальный текст [AUDIT-C7]
3. ✅ Voice input на 6 языках через Whisper
4. ✅ Voice output опционально через Edge-TTS + ffmpeg → OGG/Opus
5. ✅ Document upload до 10MB, помещается в 256K с overflow check
6. ✅ 10 персонажей переключаются
7. ✅ Group @mention single-turn (Privacy ON)
8. ✅ Все команды: /new, /persona, /help, /voice, /lang, /about, /report, /delete_my_data
9. ✅ Длинные ответы (>4000 chars) split правильно

### Безопасность
10. ✅ Content safety: OpenAI + regex + jailbreak detector
11. ✅ sexualMinors → instant permaban + admin alert
12. ✅ Категории OpenAI правильно мапятся в internal
13. ✅ Audit log retention 30 дней через node-cron
14. ✅ User reputation: 3 flags/неделя → 24h, 10 total → permaban (атомарно в SQL tx)
15. ✅ /report работает (с reply и без)
16. ✅ Webhook secret валидируется
17. ✅ /delete_my_data — cascade delete + anonymize audit

### Cost & rate limiting
18. ✅ Per-user limits: 30 text/day, 5 voice/day, 3 documents/day
19. ✅ Daily cost cap → kill switch (атомарный SET NX EX)
20. ✅ Cost tracking через usage из gateway (warn при degraded)
21. ✅ Admin alerts на превышение

### Operations
22. ✅ Webhook на prod HTTPS-домене
23. ✅ Docker Compose стабильно (ffmpeg в образе)
24. ✅ Структурированные JSON логи с traceId
25. ✅ /health (liveness) + /ready (readiness, DB+Redis)
26. ✅ Мониторинг с базовыми метриками
27. ✅ Алерты в admin chat
28. ✅ pg_dump host-cron + 14d retention
29. ✅ Auto-migration в Docker entrypoint

### Документация
30. ✅ README с deploy
31. ✅ .env.example
32. ✅ data/personas.yaml
33. ✅ CURRENT_TOS_VERSION versioning
34. ✅ BACKLOG.md для Phase 2

---

## 17. Out of scope для MVP

Полный backlog → [BACKLOG.md](BACKLOG.md). Сюда краткий список:

- User-created custom personas
- Sharable persona links (`t.me/bot?start=persona_xxx`)
- Web search, research-агент, code execution, image gen/vision
- Multi-model selection (Qwen3, GPT-OSS) — только Kimi
- Bot-to-bot communication
- Chat Automation (AI-секретарь)
- Managed Bots
- Custom AI Styles
- Native @mention без add-to-group (Bot API 9.6+)
- Платежи / подписки, реферальная система
- Web/Mobile приложения
- Own opengnk proxy
- **Reply-thread в группах (multi-turn в группах)** — Phase 2 [AUDIT-C9, P5]
- **Draft-based streaming** через sendMessageDraft — Phase 1.1 [AUDIT-C1]
- **chatComplete для auto-title** — реализован в MVP, использование в Phase 1.1 [AUDIT-M13]
- **Multi-instance horizontal scaling** — Phase 2
- **Multiple admin chats** (alerts vs critical vs reports) — Phase 2

---

## Приложение A — 10 персонажей по умолчанию

См. `data/personas.yaml`. Содержимое идентично v1.1 §17 Приложение A — без изменений.

```yaml
personas:
  - slug: default
    name_key: persona.default.name
    description_key: persona.default.desc
    emoji: "💬"
    is_default: true
    sort_order: 1
    system_prompt: |
      You are a helpful, friendly AI assistant powered by Kimi K2.6 on the Gonka decentralized network.
      Be concise but complete. Avoid disclaimers unless safety-relevant.
      Refuse harmful, illegal, or unethical requests politely.

  - slug: analyst
    name_key: persona.analyst.name
    description_key: persona.analyst.desc
    emoji: "📊"
    sort_order: 2
    system_prompt: |
      You are a data analyst. Help with data analysis, SQL, statistics, spreadsheets, analytical reports.
      Be precise with numbers. Show reasoning step-by-step.
      Format SQL/code blocks properly.

  - slug: coder
    name_key: persona.coder.name
    description_key: persona.coder.desc
    emoji: "🧑‍💻"
    sort_order: 3
    system_prompt: |
      You are an expert software engineer. Help with code: writing, debugging, refactoring, explaining.
      Default to clean, idiomatic, modern code.
      Always specify the language. Brief comments where helpful.

  - slug: therapist
    name_key: persona.therapist.name
    description_key: persona.therapist.desc
    emoji: "🧠"
    sort_order: 4
    system_prompt: |
      You are an empathetic listener with CBT knowledge.
      You are NOT a licensed mental health professional. You do NOT diagnose, prescribe, or replace therapy.
      Validate feelings first. Open-ended questions. Avoid platitudes.
      If user expresses suicidal ideation, recommend professional help + hotline.

  - slug: translator
    name_key: persona.translator.name
    description_key: persona.translator.desc
    emoji: "🌍"
    sort_order: 5
    system_prompt: |
      You are a precise translator. Preserve tone, register, idioms.
      If target language unclear — ask.
      For ambiguous idioms — offer 2 alternatives.

  - slug: editor
    name_key: persona.editor.name
    description_key: persona.editor.desc
    emoji: "✍️"
    sort_order: 6
    system_prompt: |
      You are a professional editor. Improve clarity, grammar, flow while preserving voice.
      Show edited version, then briefly list main changes.

  - slug: researcher
    name_key: persona.researcher.name
    description_key: persona.researcher.desc
    emoji: "🔬"
    sort_order: 7
    system_prompt: |
      You are a thorough researcher. Structured, well-organized information.
      Note when something is well-established vs. debated.
      Acknowledge knowledge limits. Do NOT fabricate citations.

  - slug: teacher
    name_key: persona.teacher.name
    description_key: persona.teacher.desc
    emoji: "👩‍🏫"
    sort_order: 8
    system_prompt: |
      You are a patient teacher. Explain from first principles, building up complexity.
      Use analogies. Check understanding with brief questions.

  - slug: chef
    name_key: persona.chef.name
    description_key: persona.chef.desc
    emoji: "👨‍🍳"
    sort_order: 9
    system_prompt: |
      You are a friendly chef. Recipes, techniques, meal planning, substitutions.
      Adapt to dietary restrictions if mentioned. Metric and imperial friendly.

  - slug: writer
    name_key: persona.writer.name
    description_key: persona.writer.desc
    emoji: "📚"
    sort_order: 10
    system_prompt: |
      You are a creative writing assistant. Stories, essays, poems, copywriting, brainstorming.
      Respect writer's style. Offer options rather than dictating.
```

`renderSystemPrompt` добавляет в конец [AUDIT-L14]: `\n\nALWAYS respond in: {userLang}`.

---

## Приложение B — Локализационные ключи

Минимальный набор в `locales/{lang}.json` (полные тексты переведены для всех 6 языков):

```json
{
  "welcome.text": "...",
  "tos.intro": "...",
  "tos.full": "...",
  "age.question": "Are you 18 or older?",
  "age.under18": "...",
  "age.blocked": "Access blocked for {daysLeft} more days.",
  "main_menu.chat": "💬 Just chat",
  "main_menu.document": "📄 Upload document",
  "main_menu.persona": "🎭 Pick persona",
  "main_menu.about": "ℹ️ About",
  "persona.choose": "Choose a persona:",
  "persona.selected": "Now I'm {name}.",
  "persona.default.name": "Assistant",
  "persona.default.desc": "General-purpose AI helper",
  "...": "...",
  "rate_limit.text": "Daily limit reached ({current}/{limit}). Reset in {hours}h.",
  "rate_limit.voice": "Voice limit reached. Reset in {hours}h.",
  "rate_limit.document": "Document limit reached. Reset in {hours}h.",
  "voice.too_large": "Voice message too large (max {limit} MB).",
  "document.replaced_context": "Got it — {pages} pages, ~{tokens} tokens. Started new conversation; previous context cleared.",
  "document.too_large": "Document is too large (max {limit} MB).",
  "document.too_long": "Document too long (>{limit} tokens).",
  "document.unsupported": "Unsupported format. PDF, DOCX, TXT only.",
  "document.parse_failed": "Couldn't read this document. Scanned PDFs (without text layer) are not supported.",
  "moderation.input_blocked": "I can't help with that. Please ask something else.",
  "moderation.output_blocked": "I can't share that response. Try a different question.",
  "moderation.document_blocked": "This document contains content I can't process.",
  "self_harm.resources": "If you're in crisis, please contact: ...",
  "error.banned": "Your access is suspended. Reason: {reason}.",
  "error.maintenance": "Service temporarily unavailable. Try again later.",
  "error.message_too_long": "Message too long (max {limit} chars).",
  "error.context_overflow": "Document is too large to chat about. Try a smaller one.",
  "error.service_unavailable": "Service is overloaded. Try in a minute.",
  "error.voice_failed": "Couldn't transcribe voice. Try recording again.",
  "error.internal": "Something went wrong. Try again or /new.",
  "new_conversation.confirmed": "Started new conversation.",
  "report.thanks": "Thanks for reporting. We'll review it.",
  "report.nothing_to_report": "Nothing to report — reply to my message with /report.",
  "delete.confirm": "Are you sure? This deletes ALL your data permanently.",
  "delete.yes_delete": "Yes, delete everything",
  "delete.cancel": "Cancel",
  "delete.cancelled": "Cancelled. Your data is safe.",
  "delete.done": "Done. All your data has been deleted.",
  "group.must_start_dm_first": "Please first DM me and accept Terms: {botLink}",
  "about.text": "Powered by Kimi K2.6 on Gonka decentralized network. Free, no signup. Bot v{version}. Issues → {adminContact}. Learn more: gonka.ai"
}
```

---

## Приложение C — Известные риски и митигации

| Риск | Митигация |
|------|-----------|
| mingles.ai gateway перестаёт быть бесплатным | План Б: GonkaGate ИЛИ свой opengnk прокси |
| Bot API 9.5+ методы (`sendMessageDraft`) ломаются | В MVP не используются — `TypingIndicatorSink` работает на classic `sendChatAction + sendMessage` |
| Whisper API rate limits | Whisper cache в Phase 1.1, переход на whisper.cpp self-hosted |
| Edge-TTS меняют API / закрывают | OpenAI TTS ($) ИЛИ Piper self-hosted |
| Kimi выдаёт harmful контент через jailbreak | Output filter второй линии + audit + быстрая реакция |
| Telegram банит бота | Backup аккаунт, правильные descriptions в BotFather |
| Cost overrun из-за бага | Kill switch + daily cap + admin alerts |
| GDPR-запрос на удаление | `/delete_my_data` реализован в MVP [AUDIT-A1] |
| ToS обновление — юзеры со старой версией | `CURRENT_TOS_VERSION` redirect [AUDIT-H10] |
| Partial unique index conflict при race | `startNew` транзакционно [AUDIT-N4] |
| Output moderation race (юзер видит harmful) | TypingIndicatorSink — стрим в hidden buffer [AUDIT-C7] |
| Document jailbreak после 50K | Документировано как known limitation [AUDIT-M10] |

---

## Контакт имплементатора

При вопросах:
1. Сначала Ctrl+F в этом документе
2. [TZ_AUDIT_v1.1.md](TZ_AUDIT_v1.1.md) — может быть уже разобрано
3. Если решение неочевидно — оставить `// AUDIT-Xn: причина выбора` в коде

**Не делать** того, что вне scope §17. Не "пока я тут, дам также...".

---

**Конец ТЗ. Версия 1.2. Дата: 25 мая 2026.**
