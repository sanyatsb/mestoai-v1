# Gonka Bot — Техническое задание для MVP (TypeScript)

> **Имплементатор:** Claude Opus 4.7 (vibe-coding), с последующим human review разработчиком сильным в TypeScript
> **Срок:** 6-7 недель full-time эквивалент
> **Цель документа:** дать имплементатору всю информацию для построения MVP без необходимости задавать уточняющие вопросы по архитектуре, контрактам, флоу и acceptance criteria.
> **Стек:** TypeScript 5 + Node.js 22 LTS + grammY + Drizzle ORM + PostgreSQL 16 + Redis 7

### Заметка имплементатору (важно для vibe-coding)

При vibe-coding-режиме особенно важны:
- **Строгие типы везде**: `strict: true` в `tsconfig.json`, никакого `any`, активно использовать `as const`, discriminated unions, branded types для ID (UserId vs ConversationId).
- **Zod для всех runtime границ**: env, входящие webhook'и, ответы внешних API. Парсинг → типизированный объект. Если zod падает — fail loudly с подробной ошибкой.
- **Result-pattern для бизнес-операций**: вместо throw для ожидаемых ошибок (rate limit, moderation block) — возвращать `Result<T, E>` discriminated union. throw только для unexpected.
- **Тонкие модули с явными интерфейсами**: каждый сервис в отдельном файле, экспортирует только интерфейс + factory. Зависимости инжектятся через конструктор/factory (для лёгкого тестирования).
- **Никаких side effects при импорте**: модули не должны делать ничего при загрузке, всё через явные функции инициализации.
- **Avoid magic strings**: все persona slugs, event types, severity levels — `as const` объекты с экспортируемыми типами.

---

## 0. Содержание

1. Обзор продукта и цели
2. Архитектура и стек
3. Структура проекта
4. Переменные окружения
5. Схема базы данных
6. Модули и их контракты
7. Команды бота и handler'ы
8. UX-флоу пошагово
9. Внешние интеграции (Gonka, OpenAI Moderation, Whisper, TTS)
10. Content Safety pipeline
11. Rate limiting и cost tracking
12. Логирование и мониторинг
13. Deployment (Docker, VPS)
14. Тестирование
15. Фазированный план реализации (по неделям)
16. Acceptance criteria
17. Out of scope (что НЕ делаем в MVP)

---

## 1. Обзор продукта и цели

### Что строим

Telegram-бот = AI-агент в Telegram, работающий на модели **Kimi K2.6** через децентрализованную сеть **Gonka**. Полностью бесплатный для конечного пользователя, без регистрации.

### Аудитория

Международная массовая аудитория. Мультиязычность обязательна — UX-копирайтинг минимум на 6 языках (EN, RU, ES, AR, ZH, DE). Сам Kimi отвечает на языке юзера автоматически.

### Бизнес-цель

Drive adoption для Gonka Network, накопить метрики DAU/retention/tokens-throughput для последующего питча команде Gonka на партнёрство и грант из ecosystem fund.

### Что бот умеет в MVP

1. Текстовый чат со streaming-ответами
2. Multi-turn диалоги с историей
3. Voice input (голосовое → расшифровка → ответ)
4. Voice output (опциональный, по запросу пользователя)
5. Document upload (PDF, DOCX, TXT) с использованием 256K-контекста Kimi
6. 10 пред-сделанных персонажей с разными system prompts
7. Работа в групповых чатах через @mention
8. Content safety pipeline на input/output
9. Per-user rate limiting
10. Cost ceiling с kill-switch
11. ToS и age gate
12. Audit log и user reputation

---

## 2. Архитектура и стек

### Технологический стек

| Компонент | Решение | Версия |
|-----------|---------|--------|
| Язык backend | TypeScript | 5.4+ (strict mode) |
| Runtime | Node.js | 22 LTS |
| Package manager | pnpm | 9+ (быстрее npm, лучше workspace) |
| Telegram bot framework | grammY | 1.30+ |
| ORM | Drizzle ORM | latest (типобезопасный, миграции, минимум магии) |
| База данных | PostgreSQL | 16 |
| Postgres driver | postgres-js | latest |
| Кеш / rate limit | Redis | 7 |
| Redis client | ioredis | 5+ |
| Background tasks (Phase 2+) | BullMQ | latest |
| HTTP клиент | undici (встроен в Node 22) | — |
| Validation / schemas | zod | 3+ |
| PDF parsing | unpdf | latest (modern, легче чем pdf-parse) |
| DOCX parsing | mammoth | 1+ |
| Token counting | @dqbd/tiktoken | latest (WASM-порт OpenAI tiktoken) |
| Контейнеризация | Docker + Docker Compose | latest |
| Reverse proxy | Caddy (auto HTTPS) | latest |
| Логирование | pino + pino-pretty (dev) | latest |
| Тестирование | vitest | latest |
| Линтер/форматтер | Biome (заменяет ESLint+Prettier, в 10× быстрее) | latest |
| Build | tsx (для dev), tsc или esbuild (для production) | latest |

### Структура package.json (ключевые скрипты)

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
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

### tsconfig.json (обязательные настройки)

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
| mingles.ai gateway | Доступ к Kimi K2.6 через Gonka (на старте) | Бесплатно в beta |
| OpenAI Moderation API | Input/Output safety filter | Бесплатно |
| OpenAI Whisper API | Voice → text | $0.006/мин |
| Microsoft Edge-TTS (через `msedge-tts` npm) | Text → voice | Бесплатно |

### Высокоуровневая архитектура

```
┌─────────────────┐
│  Telegram User  │
└────────┬────────┘
         │ webhook
         ▼
┌─────────────────────────────────────┐
│  Caddy (HTTPS termination)          │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  grammY bot (на Node.js fetch/HTTP) │
│  ┌──────────────────────────────┐   │
│  │ Composers (handlers)         │   │
│  ├──────────────────────────────┤   │
│  │ Services (DI через factory): │   │
│  │ - GonkaClient                │   │
│  │ - ModerationService          │   │
│  │ - RateLimiter                │   │
│  │ - CostTracker                │   │
│  │ - VoiceService               │   │
│  │ - DocumentService            │   │
│  │ - PersonaService             │   │
│  └──────────────────────────────┘   │
└────────┬───────┬───────┬────────────┘
         │       │       │
         ▼       ▼       ▼
   ┌────────┐ ┌──────┐ ┌──────────┐
   │Postgres│ │Redis │ │ External │
   │        │ │      │ │  APIs    │
   └────────┘ └──────┘ └──────────┘
```

### Webhook vs polling

**Используем webhook** через встроенный HTTP-сервер grammY (или интеграцию с Hono/Fastify, см. ниже). Polling — только для local development через `grammy dev`.

### HTTP-сервер: grammY + Hono

Для веб-сервера используем **Hono** — лёгкий, быстрый, hyper-современный фреймворк. grammY интегрируется через `@grammyjs/webhook-callback`:

```typescript
import { Hono } from 'hono';
import { webhookCallback } from 'grammy';

const app = new Hono();
app.get('/health', (c) => c.json({ status: 'ok' }));
app.post('/webhook', webhookCallback(bot, 'hono', {
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
├── .env.example
├── .gitignore
├── src/
│   ├── main.ts                     # entry point
│   ├── config.ts                   # zod-валидируемый Env
│   ├── types.ts                    # глобальные типы (Result, UserId, etc.)
│   ├── bot/
│   │   ├── app.ts                  # bot инстанс + composer registration
│   │   ├── context.ts              # extended ctx type (with i18n, user, services)
│   │   ├── middlewares/
│   │   │   ├── auth.ts             # user lookup / ToS / age gate
│   │   │   ├── rate-limit.ts
│   │   │   ├── i18n.ts             # языковой контекст
│   │   │   ├── kill-switch.ts
│   │   │   └── logging.ts
│   │   ├── composers/
│   │   │   ├── start.ts            # /start, ToS, age gate flow
│   │   │   ├── help.ts
│   │   │   ├── chat.ts             # основной handler для текста
│   │   │   ├── voice.ts            # /voice toggle + voice messages
│   │   │   ├── document.ts
│   │   │   ├── persona.ts
│   │   │   ├── new.ts
│   │   │   ├── about.ts
│   │   │   ├── report.ts
│   │   │   ├── lang.ts
│   │   │   ├── group.ts            # групповые чаты
│   │   │   └── admin.ts            # админ-команды
│   │   └── keyboards/
│   │       ├── main-menu.ts
│   │       ├── personas.ts
│   │       ├── tos.ts
│   │       └── confirm.ts
│   ├── services/
│   │   ├── gonka-client.ts         # обёртка над mingles.ai gateway (SSE streaming)
│   │   ├── moderation.ts           # OpenAI Moderation + regex
│   │   ├── jailbreak-detector.ts
│   │   ├── voice.ts                # Whisper + Edge-TTS
│   │   ├── document.ts             # PDF/DOCX/TXT extraction
│   │   ├── persona.ts              # системные промпты
│   │   ├── rate-limiter.ts
│   │   ├── cost-tracker.ts
│   │   ├── conversation.ts         # история диалога
│   │   └── i18n.ts                 # переводы UX-копирайтинга
│   ├── db/
│   │   ├── schema.ts               # Drizzle-схемы всех таблиц
│   │   ├── client.ts               # createDb factory
│   │   ├── relations.ts            # Drizzle relations
│   │   └── repositories/
│   │       ├── users.ts
│   │       ├── conversations.ts
│   │       ├── messages.ts
│   │       ├── audit-log.ts
│   │       └── personas.ts
│   ├── locales/
│   │   ├── en.json
│   │   ├── ru.json
│   │   ├── es.json
│   │   ├── ar.json
│   │   ├── zh.json
│   │   └── de.json
│   ├── utils/
│   │   ├── result.ts               # Result<T,E> helpers
│   │   ├── retry.ts
│   │   ├── tokenizer.ts            # tiktoken wrapper
│   │   ├── streaming.ts            # SSE parsing хелперы
│   │   ├── logger.ts               # pino instance
│   │   └── ids.ts                  # branded ID types + factories
│   └── data/
│       └── personas.yaml           # описание 10 готовых персонажей
├── drizzle/
│   └── migrations/                 # auto-generated by drizzle-kit
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── scripts/
    ├── set-webhook.ts
    └── seed-personas.ts
```

---

## 4. Переменные окружения

Файл `.env.example`. Все переменные **валидируются через zod при старте**: если хоть одна отсутствует или не парсится — приложение крашится сразу с понятным сообщением (см. `src/config.ts`).

```bash
# ===== Node =====
NODE_ENV=development                # development | production
PORT=8080

# ===== Telegram =====
BOT_TOKEN=                          # от BotFather
BOT_USERNAME=                       # без @
WEBHOOK_URL=                        # https://bot.yourdomain.com/webhook
WEBHOOK_SECRET=                     # random 32+ chars
WEBHOOK_PATH=/webhook

# ===== Gonka access =====
GONKA_GATEWAY_URL=https://gateway.mingles.ai/v1
GONKA_API_KEY=
GONKA_MODEL=Kimi-K2.6
GONKA_TIMEOUT_MS=120000
GONKA_MAX_RETRIES=2

# ===== OpenAI =====
OPENAI_API_KEY=
OPENAI_MODERATION_MODEL=omni-moderation-latest
OPENAI_WHISPER_MODEL=whisper-1

# ===== Database =====
DATABASE_URL=postgres://gonka:password@postgres:5432/gonka_bot

# ===== Redis =====
REDIS_URL=redis://redis:6379/0

# ===== Rate limits =====
RATE_LIMIT_TEXT_PER_DAY=30
RATE_LIMIT_VOICE_PER_DAY=5
RATE_LIMIT_DOCUMENT_PER_DAY=3
MAX_DOCUMENT_SIZE_MB=10
MAX_MESSAGE_LENGTH_CHARS=8000

# ===== Cost controls =====
DAILY_BUDGET_USD=50
COST_ALERT_THRESHOLD_USD=30
COST_PER_INPUT_TOKEN_USD=0.0000003
COST_PER_OUTPUT_TOKEN_USD=0.0000012

# ===== Moderation thresholds =====
MOD_THRESHOLD_SEXUAL_MINORS=0.2
MOD_THRESHOLD_HARM=0.6
MOD_THRESHOLD_VIOLENCE=0.7
MOD_THRESHOLD_HATE=0.6
MOD_THRESHOLD_SELF_HARM=0.5
MOD_THRESHOLD_SEXUAL=0.7
USER_BAN_FLAG_THRESHOLD=3
USER_PERMABAN_FLAG_THRESHOLD=10

# ===== Admin =====
ADMIN_TG_IDS=123456789,987654321    # через запятую
ADMIN_CHAT_ID=

# ===== Feature flags =====
FEATURE_VOICE_INPUT=true
FEATURE_VOICE_OUTPUT=true
FEATURE_DOCUMENTS=true
FEATURE_GROUPS=true
KILL_SWITCH=false

# ===== Logging =====
LOG_LEVEL=info                       # trace | debug | info | warn | error | fatal
LOG_FORMAT=json                      # json | pretty (для dev)
```

### Пример `src/config.ts` с zod-валидацией

```typescript
import { z } from 'zod';
import 'dotenv/config';

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
  
  ADMIN_TG_IDS: z.string().transform((s) => s.split(',').map((x) => Number(x.trim())).filter(Boolean)),
  ADMIN_CHAT_ID: z.coerce.number(),
  
  FEATURE_VOICE_INPUT: z.coerce.boolean().default(true),
  FEATURE_VOICE_OUTPUT: z.coerce.boolean().default(true),
  FEATURE_DOCUMENTS: z.coerce.boolean().default(true),
  FEATURE_GROUPS: z.coerce.boolean().default(true),
  KILL_SWITCH: z.coerce.boolean().default(false),
  
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
```

При запуске любая невалидная переменная даст подробный ошибку с указанием конкретного поля.

---

## 5. Схема базы данных

### Миграции

Используем **Drizzle Kit** для миграций. Схема описана как TypeScript-код в `src/db/schema.ts` — миграции генерируются автоматически командой `pnpm db:generate`.

### TypeScript-схема (`src/db/schema.ts`)

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
  
  activePersonaId: integer('active_persona_id'),
  activeConversationId: bigint('active_conversation_id', { mode: 'number' }),
  
  flagCountTotal: integer('flag_count_total').default(0),
  flagCountWeek: integer('flag_count_week').default(0),
  flagCountWeekResetAt: timestamp('flag_count_week_reset_at', { withTimezone: true }).defaultNow(),
  bannedUntil: timestamp('banned_until', { withTimezone: true }),
  bannedPermanent: boolean('banned_permanent').default(false),
  banReason: text('ban_reason'),
  
  voiceOutputEnabled: boolean('voice_output_enabled').default(false),
  
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
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
  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
  personaId: integer('persona_id').references(() => personas.id),
  title: text('title'),
  documentText: text('document_text'),
  documentName: text('document_name'),
  documentTokens: integer('document_tokens'),
  isActive: boolean('is_active').default(true),
  groupChatId: bigint('group_chat_id', { mode: 'number' }),
  botMessageId: bigint('bot_message_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  userActiveIdx: index('idx_conversations_user_active').on(t.userId, t.isActive),
  groupThreadIdx: index('idx_conversations_group_thread').on(t.groupChatId, t.botMessageId),
}));

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conversationId: bigint('conversation_id', { mode: 'number' }).notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['system', 'user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 8 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  convIdx: index('idx_messages_conv').on(t.conversationId, t.createdAt),
}));

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  eventType: text('event_type').notNull(),
  severity: text('severity', { enum: ['low', 'medium', 'high', 'critical'] }).notNull(),
  contentHash: text('content_hash'),
  contentExcerpt: text('content_excerpt'),
  categories: jsonb('categories'),
  moderationScores: jsonb('moderation_scores'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  userIdx: index('idx_audit_user').on(t.userId, t.createdAt),
  eventIdx: index('idx_audit_event').on(t.eventType, t.createdAt),
}));

export const usageStatsDaily = pgTable('usage_stats_daily', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  date: text('date').notNull(),                                          // YYYY-MM-DD
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  textMessages: integer('text_messages').default(0),
  voiceMessages: integer('voice_messages').default(0),
  documents: integer('documents').default(0),
  tokensInput: bigint('tokens_input', { mode: 'number' }).default(0),
  tokensOutput: bigint('tokens_output', { mode: 'number' }).default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).default('0'),
}, (t) => ({
  dateUserIdx: uniqueIndex('idx_usage_date_user').on(t.date, t.userId),
  dateIdx: index('idx_usage_date').on(t.date),
}));

export const userReports = pgTable('user_reports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  reporterUserId: bigint('reporter_user_id', { mode: 'number' }).references(() => users.id),
  messageId: bigint('message_id', { mode: 'number' }).references(() => messages.id),
  reason: text('reason'),
  status: text('status', { enum: ['pending', 'reviewed', 'actioned'] }).default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

// Inferred types для использования в repositories/services
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Persona = typeof personas.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
```

### `drizzle.config.ts`

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

### Команды миграций

```bash
pnpm db:generate    # сгенерировать миграцию из schema.ts
pnpm db:migrate     # применить миграции
pnpm db:studio      # web UI для просмотра БД (полезно при разработке)
```

---

## 6. Модули и их контракты

### 6.0 Общие типы (`src/types.ts`)

```typescript
// Branded ID types — нельзя случайно передать UserId вместо ConversationId
export type UserId = number & { readonly __brand: 'UserId' };
export type ConversationId = number & { readonly __brand: 'ConversationId' };
export type MessageId = number & { readonly __brand: 'MessageId' };
export type PersonaId = number & { readonly __brand: 'PersonaId' };
export type TelegramUserId = number & { readonly __brand: 'TelegramUserId' };

// Result pattern для ожидаемых ошибок
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// Discriminated unions для domain-ошибок
export type DomainError =
  | { kind: 'rate_limit'; current: number; limit: number; resetsInSec: number }
  | { kind: 'banned'; reason: string; until: Date | null }
  | { kind: 'moderation_blocked'; categories: string[] }
  | { kind: 'kill_switch_active' }
  | { kind: 'service_unavailable'; service: string }
  | { kind: 'validation'; field: string; message: string };
```

### 6.1 `services/gonka-client.ts`

Обёртка над OpenAI-совместимым endpoint'ом mingles.ai gateway.

```typescript
export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface StreamChunk {
  delta: string;
  tokensInput?: number;       // только в финальном chunk
  tokensOutput?: number;      // только в финальном chunk
  finishReason?: 'stop' | 'length' | 'content_filter' | null;
  done: boolean;
}

export interface ChatStreamOptions {
  messages: ChatMessage[];
  maxTokens?: number;          // default 4096
  temperature?: number;        // default 0.7
  signal?: AbortSignal;        // для отмены
}

export interface GonkaClient {
  /**
   * Стрим через SSE. Итерирует StreamChunk до получения done: true.
   */
  chatStream(opts: ChatStreamOptions): AsyncIterable<StreamChunk>;

  /**
   * Не-стриминговая версия для коротких вызовов (например, генерации заголовка).
   */
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
- Использует `fetch` (Node 22 встроенный) с `AbortController` для таймаутов
- Retry с exponential backoff (max 2 раза) на 5xx и network errors
- Логирует каждый запрос: длительность, токены, стоимость
- При 4xx — НЕ ретраит, возвращает ошибку
- SSE-парсинг: реализовать вручную через `response.body.getReader()` + `TextDecoder`
- Финальный chunk содержит `usage` объект — извлечь и положить в последний `StreamChunk`

### 6.2 `services/moderation.ts`

```typescript
export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
  decision: 'allow' | 'block';
  severity: 'low' | 'medium' | 'high' | 'critical';
  triggeredCategories: string[];
}

export interface ModerationService {
  /**
   * Pipeline:
   *  1. Regex blacklist (мгновенный отсев)
   *  2. Jailbreak detector
   *  3. OpenAI Moderation API
   *  4. Применить пороги, вернуть decision
   *
   * Side effects:
   *  - При block: запись в audit_log
   *  - При block: инкремент user.flag_count_week
   *  - При threshold reached: ban user
   */
  checkInput(text: string, userId: UserId, lang: string): Promise<ModerationResult>;
  
  /**
   * То же для ответа модели. При block ответ юзеру НЕ показываем.
   */
  checkOutput(text: string, userId: UserId, lang: string): Promise<ModerationResult>;
}

export function createModerationService(deps: {
  openaiApiKey: string;
  jailbreak: JailbreakDetector;
  blacklist: BlacklistChecker;
  auditLog: AuditLogRepository;
  users: UsersRepository;
  thresholds: ModerationThresholds;
  logger: Logger;
}): ModerationService;
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

### 6.4 `services/voice.ts`

```typescript
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export interface VoiceService {
  /**
   * Прогон voice file (.ogg) через Whisper.
   * language — ISO 639-1 (en, ru, es, ...). Если undefined, Whisper определит сам.
   */
  transcribe(audioBytes: Uint8Array, language?: string): Promise<Result<string, DomainError>>;
  
  /**
   * Edge-TTS синтез текста в MP3. Возвращает байты.
   */
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
  logger: Logger;
}): VoiceService;
```

### 6.5 `services/document.ts`

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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'text/plain',
  'text/markdown',
] as const;

export function createDocumentService(deps: {
  tokenizer: Tokenizer;
  logger: Logger;
}): DocumentService;
```

**Имплементация:**
- PDF: `unpdf` (modern, работает в edge runtimes тоже)
- DOCX: `mammoth` — извлекает чистый текст без форматирования
- TXT/MD: просто `new TextDecoder('utf-8').decode(fileBytes)`

### 6.6 `services/persona.ts`

```typescript
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

export type PersonaSlug =
  | 'default'
  | 'analyst'
  | 'coder'
  | 'therapist'
  | 'translator'
  | 'editor'
  | 'researcher'
  | 'teacher'
  | 'chef'
  | 'writer';

export interface PersonaService {
  listActive(): Promise<Persona[]>;
  getBySlug(slug: PersonaSlug): Promise<Persona | null>;
  getById(id: PersonaId): Promise<Persona | null>;
  getDefault(): Promise<Persona>;
  
  /**
   * Финальный системный промпт:
   * 1. Базовый prompt персонажа
   * 2. Указание языка ответа = userLang
   * 3. Если есть document — его содержимое в конце
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

### 6.7 `services/rate-limiter.ts`

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
   * Redis: INCR + EXPIRE 86400
   * key = `rl:${kind}:${userId}:${YYYY-MM-DD}`
   */
  checkAndIncrement(userId: UserId, kind: RateLimitKind): Promise<RateLimitResult>;
}

export function createRateLimiter(deps: {
  redis: Redis;
  limits: Record<RateLimitKind, number>;
  logger: Logger;
}): RateLimiter;
```

### 6.8 `services/cost-tracker.ts`

```typescript
export interface CostTrackingResult {
  dailyTotalUsd: number;
  overAlertThreshold: boolean;
  overKillThreshold: boolean;
}

export interface CostTracker {
  trackRequest(opts: {
    userId: UserId;
    tokensInput: number;
    tokensOutput: number;
  }): Promise<CostTrackingResult>;
  
  isKillSwitchActive(): Promise<boolean>;
  
  /**
   * Вызывается cron'ом в 00:00 UTC ежедневно — сбросить alerted_today флаг.
   */
  resetDailyFlags(): Promise<void>;
}

export function createCostTracker(deps: {
  db: Database;
  redis: Redis;
  bot: Bot;                          // для алертов в admin chat
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

### 6.9 `services/conversation.ts`

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
  startNew(userId: UserId, opts?: {
    personaId?: PersonaId;
    groupChatId?: number;
  }): Promise<Conversation>;
  setPersona(conversationId: ConversationId, personaId: PersonaId): Promise<void>;
  
  appendMessage(opts: {
    conversationId: ConversationId;
    role: ChatRole;
    content: string;
    tokensInput?: number;
    tokensOutput?: number;
    costUsd?: number;
  }): Promise<MessageId>;
  
  /**
   * Получить сообщения в формате для LLM.
   * Если суммарно > maxTotalTokens — trim самые старые (system prompt сохраняется).
   */
  getMessagesForLlm(opts: {
    conversationId: ConversationId;
    maxHistory?: number;       // default 20
    maxTotalTokens?: number;   // default 200_000
  }): Promise<ChatMessage[]>;
  
  attachDocument(opts: {
    conversationId: ConversationId;
    text: string;
    documentName: string;
    tokens: number;
  }): Promise<void>;
  
  /**
   * Для групповых чатов — mapping (group_chat_id, message_id) -> conversation
   */
  saveGroupThread(opts: {
    conversationId: ConversationId;
    groupChatId: number;
    botMessageId: number;
  }): Promise<void>;
  
  getByGroupThread(opts: {
    groupChatId: number;
    botMessageId: number;
  }): Promise<Conversation | null>;
}

export function createConversationService(deps: {
  conversations: ConversationsRepository;
  messages: MessagesRepository;
  tokenizer: Tokenizer;
  logger: Logger;
}): ConversationService;
```

### 6.10 `services/i18n.ts`

```typescript
import enLocale from '../locales/en.json' assert { type: 'json' };
import ruLocale from '../locales/ru.json' assert { type: 'json' };
// ... остальные

const LOCALES = {
  en: enLocale,
  ru: ruLocale,
  es: esLocale,
  ar: arLocale,
  zh: zhLocale,
  de: deLocale,
} as const;

export type SupportedLang = keyof typeof LOCALES;

export interface I18nService {
  t(key: string, lang: SupportedLang | string, params?: Record<string, string | number>): string;
  
  /**
   * Маппинг tg language_code → наш supported lang.
   * 'en-US' → 'en', 'ru' → 'ru', 'unsupported' → 'en' (fallback).
   */
  resolveLang(tgLanguageCode: string | undefined): SupportedLang;
}

export function createI18nService(): I18nService;
```

### 6.11 `bot/context.ts` — расширенный grammY context

```typescript
import type { Context, SessionFlavor } from 'grammy';
import type { I18nFlavor } from '@grammyjs/i18n';

export interface SessionData {
  // empty for now — session живёт в DB, не в Redis-сессии grammY
}

export interface CustomCtx {
  // Инжектируем через middleware
  user?: User;                          // загружается из DB по tg_id
  lang: SupportedLang;
  services: {
    gonka: GonkaClient;
    moderation: ModerationService;
    voice: VoiceService;
    document: DocumentService;
    persona: PersonaService;
    rateLimit: RateLimiter;
    cost: CostTracker;
    conversation: ConversationService;
    i18n: I18nService;
  };
  t(key: string, params?: Record<string, string | number>): string;
}

export type MyContext = Context & CustomCtx & SessionFlavor<SessionData>;
```

Это даёт автокомплит в каждом handler'е: `ctx.user`, `ctx.t('key')`, `ctx.services.gonka.chatStream(...)` — всё типизировано.

---

## 7. Команды бота и handler'ы

### Полный список команд

| Команда | Описание | Доступна в | Handler |
|---------|----------|------------|---------|
| `/start` | Старт + ToS + age gate + welcome | DM only | `handlers/start.py` |
| `/help` | Помощь | DM | `handlers/help.py` |
| `/new` | Сбросить контекст текущего диалога | DM | `handlers/new.py` |
| `/persona` | Выбрать персонажа | DM | `handlers/persona.py` |
| `/about` | Информация о боте, ссылка на Gonka | DM, group | `handlers/about.py` |
| `/voice` | Включить/выключить голосовые ответы | DM | `handlers/voice.py` |
| `/lang` | Сменить язык интерфейса | DM | `handlers/start.py` |
| `/report` | Сообщить о проблеме (последний ответ) | DM | `handlers/report.py` |
| `/kill` | (admin only) включить kill switch | DM | `handlers/admin.py` |
| `/stats` | (admin only) статистика | DM | `handlers/admin.py` |

### Не-команды (обработчики message types)

| Тип сообщения | Handler |
|---------------|---------|
| `text` (DM) | `chat.py::handle_text_message` |
| `voice` (DM) | `voice.py::handle_voice_message` |
| `document` (DM) | `document.py::handle_document_upload` |
| `text` с `@bot_username` в группе | `group.py::handle_group_mention` |
| `reply_to_message.from_user.is_bot == True && this bot` в группе | `group.py::handle_group_reply` |

---

## 8. UX-флоу пошагово

### 8.1 Первый старт (`/start`)

```
1. User sends /start
2. Bot checks DB:
   - if user does NOT exist:
       create user with language_code from tg_user.language_code (fallback 'en')
       proceed to ToS flow
   - if user exists but tos_accepted_at is null:
       proceed to ToS flow
   - if user exists and tos_accepted is OK but age_confirmed_at is null:
       proceed to age gate
   - if both done:
       show main welcome
3. ToS flow:
   - Send message with t('tos.intro', lang)
   - Show inline keyboard:
     [✅ Accept] [📄 Read full text]
   - On Accept:
     update users.tos_accepted_at = NOW(), tos_version = '1.0'
     proceed to age gate
   - On Read: send full ToS text, wait for Accept
4. Age gate:
   - Send t('age.question', lang) — "Are you 18 or older?"
   - Inline keyboard: [Yes, 18+] [No]
   - On Yes: update users.age_confirmed_at = NOW(), proceed to welcome
   - On No: send t('age.under18') and end conversation (user can /start again after some time)
5. Main welcome:
   - Send t('welcome.text', lang)
   - Inline keyboard:
     [💬 Just chat] [📄 Upload document] [🎭 Pick persona] [ℹ️ About]
   - Set active_persona_id = default persona
6. Done. User can now send messages.
```

### 8.2 Текстовое сообщение в DM

```typescript
import type { MyContext } from '../context';
import type { Message } from 'grammy/types';

export async function handleTextMessage(ctx: MyContext): Promise<void> {
  const user = ctx.user!;                          // garantirovan auth middleware'ом
  const text = ctx.message!.text!;
  const { gonka, moderation, rateLimit, cost, conversation, persona } = ctx.services;
  
  // 1. Bans / kill switch — обрабатываются в middleware заранее
  
  // 2. Rate limit
  const rl = await rateLimit.checkAndIncrement(user.id, 'text');
  if (!rl.allowed) {
    await ctx.reply(ctx.t('rate_limit.text', {
      current: rl.current,
      limit: rl.limit,
      hours: Math.ceil(rl.resetsInSec / 3600),
    }));
    return;
  }
  
  // 3. Input moderation
  const modIn = await moderation.checkInput(text, user.id, ctx.lang);
  if (modIn.decision === 'block') {
    await ctx.reply(ctx.t('moderation.input_blocked'));
    return;
  }
  
  // 4. Get conversation, append user message
  const conv = await conversation.getOrCreateActive(user.id);
  const activePersona = await persona.getById(conv.personaId ?? user.activePersonaId!);
  
  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'user',
    content: text,
  });
  
  // 5. Build messages for LLM
  const systemPrompt = persona.renderSystemPrompt({
    persona: activePersona!,
    userLang: ctx.lang,
    documentText: conv.documentText ?? undefined,
  });
  const history = await conversation.getMessagesForLlm({ conversationId: conv.id });
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];
  
  // 6. Send draft (streaming)
  const draftId = Date.now();
  let accumulated = '';
  let lastSendAt = 0;
  let finalUsage: { tokensInput: number; tokensOutput: number } | null = null;
  
  for await (const chunk of gonka.chatStream({ messages: llmMessages })) {
    accumulated += chunk.delta;
    const now = Date.now();
    if (now - lastSendAt > 500) {                      // throttle: 2 updates/sec
      await ctx.api.raw.sendMessageDraft({
        chat_id: ctx.chat!.id,
        draft_id: draftId,
        text: accumulated,
      });
      lastSendAt = now;
    }
    if (chunk.done) {
      finalUsage = {
        tokensInput: chunk.tokensInput ?? 0,
        tokensOutput: chunk.tokensOutput ?? 0,
      };
    }
  }
  
  // 7. Output moderation
  const modOut = await moderation.checkOutput(accumulated, user.id, ctx.lang);
  if (modOut.decision === 'block') {
    await ctx.reply(ctx.t('moderation.output_blocked'));
    return;
  }
  
  // 8. Finalize (commit draft as real message)
  const sentMsg = await ctx.reply(accumulated, {
    reply_markup: buildReportKeyboard(),
  });
  
  // 9. Persist
  await conversation.appendMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: accumulated,
    tokensInput: finalUsage?.tokensInput,
    tokensOutput: finalUsage?.tokensOutput,
    costUsd: calculateCost(finalUsage),
  });
  
  // 10. Cost tracking
  if (finalUsage) {
    await cost.trackRequest({
      userId: user.id,
      tokensInput: finalUsage.tokensInput,
      tokensOutput: finalUsage.tokensOutput,
    });
  }
  
  // 11. Voice output (if enabled)
  if (user.voiceOutputEnabled) {
    const voiceResult = await ctx.services.voice.synthesize(accumulated, ctx.lang);
    if (voiceResult.ok) {
      await ctx.replyWithVoice(new InputFile(voiceResult.value, 'response.mp3'));
    }
  }
}
```

Прочие handler'ы (voice, document, persona, group) следуют той же структуре. В разделе 8 остаются псевдо-логические описания флоу (см. ниже) — имплементатор переводит их в TS аналогично.

### 8.3 Голосовое сообщение

```typescript
export async function handleVoiceMessage(ctx: MyContext): Promise<void> {
  // 1. Standard pre-checks (banned, kill switch via middleware)
  // 2. Rate limit на 'voice'
  const rl = await ctx.services.rateLimit.checkAndIncrement(ctx.user!.id, 'voice');
  if (!rl.allowed) {
    await ctx.reply(ctx.t('rate_limit.voice', {
      hours: Math.ceil(rl.resetsInSec / 3600),
    }));
    return;
  }
  
  // 3. Download voice file (.ogg)
  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const audioBytes = new Uint8Array(await response.arrayBuffer());
  
  // 4. Transcribe via Whisper
  const result = await ctx.services.voice.transcribe(audioBytes, ctx.lang);
  if (!result.ok) {
    await ctx.reply(ctx.t('error.voice_failed'));
    return;
  }
  
  // 5. Confirm transcription
  await ctx.reply(`📝 ${result.value}`, { reply_parameters: { message_id: ctx.message!.message_id } });
  
  // 6. Pass through text pipeline (re-using handler with override)
  await handleTextMessageInternal(ctx, result.value);
}
```

### 8.4 Загрузка документа

```typescript
export async function handleDocumentUpload(ctx: MyContext): Promise<void> {
  const user = ctx.user!;
  const doc = ctx.message!.document!;
  
  // 1. Rate limit на 'document'
  const rl = await ctx.services.rateLimit.checkAndIncrement(user.id, 'document');
  if (!rl.allowed) { /* ... */ return; }
  
  // 2. Validate size and mime
  if (doc.file_size && doc.file_size > env.MAX_DOCUMENT_SIZE_MB * 1024 * 1024) {
    await ctx.reply(ctx.t('document.too_large', { limit: env.MAX_DOCUMENT_SIZE_MB }));
    return;
  }
  
  if (!SUPPORTED_MIME_TYPES.includes(doc.mime_type as any)) {
    await ctx.reply(ctx.t('document.unsupported'));
    return;
  }
  
  // 3. Download
  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
  const fileBytes = new Uint8Array(await (await fetch(fileUrl)).arrayBuffer());
  
  // 4. Extract
  const extractResult = await ctx.services.document.extractText({
    fileBytes,
    mimeType: doc.mime_type!,
    maxSizeMb: env.MAX_DOCUMENT_SIZE_MB,
  });
  if (!extractResult.ok) {
    await ctx.reply(ctx.t(`document.${extractResult.error.kind}`));
    return;
  }
  
  const extracted = extractResult.value;
  if (extracted.tokensEstimate > 200_000) {
    await ctx.reply(ctx.t('document.too_long'));
    return;
  }
  
  // 5. Moderate first 50K chars
  const modResult = await ctx.services.moderation.checkInput(
    extracted.text.slice(0, 50_000),
    user.id,
    ctx.lang
  );
  if (modResult.decision === 'block') {
    await ctx.reply(ctx.t('moderation.document_blocked'));
    return;
  }
  
  // 6. Attach to NEW conversation
  const conv = await ctx.services.conversation.startNew(user.id);
  await ctx.services.conversation.attachDocument({
    conversationId: conv.id,
    text: extracted.text,
    documentName: doc.file_name ?? 'document',
    tokens: extracted.tokensEstimate,
  });
  
  // 7. Acknowledge
  await ctx.reply(ctx.t('document.received', {
    pages: extracted.pages,
    tokens: extracted.tokensEstimate,
  }));
}
```

### 8.5 Выбор персонажа

```typescript
export async function handlePersonaCommand(ctx: MyContext): Promise<void> {
  const personas = await ctx.services.persona.listActive();
  const keyboard = buildPersonaKeyboard(personas, ctx.lang);
  await ctx.reply(ctx.t('persona.choose'), { reply_markup: keyboard });
}

export async function handlePersonaCallback(ctx: MyContext): Promise<void> {
  const slug = ctx.callbackQuery!.data!.split(':')[1] as PersonaSlug;
  const chosen = await ctx.services.persona.getBySlug(slug);
  if (!chosen) {
    await ctx.answerCallbackQuery({ text: 'Not found' });
    return;
  }
  
  // Start new conversation with this persona
  const conv = await ctx.services.conversation.startNew(ctx.user!.id, { personaId: chosen.id });
  await usersRepo.update(ctx.user!.id, {
    activePersonaId: chosen.id,
    activeConversationId: conv.id,
  });
  
  await ctx.editMessageText(ctx.t('persona.selected', { name: ctx.t(chosen.nameKey) }));
  await ctx.answerCallbackQuery();
}
```

### 8.6 Сообщение в групповом чате (@mention)

```typescript
export async function handleGroupMention(ctx: MyContext): Promise<void> {
  /**
   * Срабатывает на @bot_username в группе или reply на сообщение бота.
   * Privacy mode у бота ON — иные сообщения сюда не приходят.
   */
  const text = stripMention(ctx.message!.text!, env.BOT_USERNAME);
  
  if (!ctx.user?.tosAcceptedAt) {
    await ctx.reply(ctx.t('group.must_start_dm_first', {
      botLink: `https://t.me/${env.BOT_USERNAME}`,
    }), { reply_parameters: { message_id: ctx.message!.message_id } });
    return;
  }
  
  // Standard pre-checks через middleware (kill switch, ban)
  // Rate limit
  // ...
  
  // Resolve conversation: if reply to bot — continue that thread, else new
  let conv: Conversation;
  const replyTo = ctx.message!.reply_to_message;
  if (replyTo && replyTo.from?.id === ctx.me.id) {
    const found = await ctx.services.conversation.getByGroupThread({
      groupChatId: ctx.chat!.id,
      botMessageId: replyTo.message_id,
    });
    conv = found ?? await ctx.services.conversation.startNew(ctx.user.id, {
      groupChatId: ctx.chat!.id,
    });
  } else {
    conv = await ctx.services.conversation.startNew(ctx.user.id, {
      groupChatId: ctx.chat!.id,
    });
  }
  
  // ... rest same as handleTextMessage (moderation, streaming, persist)
  // Reply in group, save group thread mapping
}
```

---

## 9. Внешние интеграции

### 9.1 mingles.ai gateway → Gonka

**Endpoint:** `https://gateway.mingles.ai/v1/chat/completions`

**Аутентификация:** `Authorization: Bearer {GONKA_API_KEY}`

**Стандарт:** OpenAI-compatible. Поддерживает `stream: true`.

**Пример запроса:**

```http
POST /v1/chat/completions HTTP/1.1
Host: gateway.mingles.ai
Authorization: Bearer sk-xxx
Content-Type: application/json

{
  "model": "Kimi-K2.6",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant. Respond in Russian."},
    {"role": "user", "content": "Привет!"}
  ],
  "max_tokens": 4096,
  "temperature": 0.7,
  "stream": true
}
```

**Стрим ответа (SSE):**

```
data: {"choices":[{"delta":{"role":"assistant"}}]}
data: {"choices":[{"delta":{"content":"Прив"}}]}
data: {"choices":[{"delta":{"content":"ет"}}]}
...
data: {"choices":[{"delta":{},"finish_reason":"stop"}], "usage":{"prompt_tokens":15,"completion_tokens":7}}
data: [DONE]
```

**Tokens & cost:** считать по полю `usage` в финальном чанке. Если поле отсутствует — оценить через tiktoken.

**Известные ошибки и обработка:**

- `429 Too Many Requests` → ретрай с backoff
- `5xx` → ретрай 1 раз, потом fallback ответ
- `timeout` → отдать юзеру шаблон «сервис временно перегружен, попробуй через минуту»

### 9.2 OpenAI Moderation API

**Endpoint:** `https://api.openai.com/v1/moderations`

**Стоимость:** Бесплатно.

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

async function moderate(text: string): Promise<ModerationApiResult> {
  const response = await openai.moderations.create({
    model: 'omni-moderation-latest',
    input: text,
  });
  const result = response.results[0]!;
  return {
    flagged: result.flagged,
    categories: result.categories as Record<string, boolean>,
    scores: result.category_scores as Record<string, number>,
  };
}
```

Применить пороги из ENV — если хоть одна категория превышает свой порог → block.

### 9.3 OpenAI Whisper

```typescript
import OpenAI, { toFile } from 'openai';

async function transcribe(audioBytes: Uint8Array, language?: string): Promise<string> {
  const response = await openai.audio.transcriptions.create({
    file: await toFile(audioBytes, 'audio.ogg', { type: 'audio/ogg' }),
    model: 'whisper-1',
    language,                              // ISO 639-1
  });
  return response.text;
}
```

### 9.4 Edge-TTS

```typescript
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const VOICE_MAP: Record<string, string> = {
  en: 'en-US-AriaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  es: 'es-ES-ElviraNeural',
  ar: 'ar-EG-SalmaNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  de: 'de-DE-KatjaNeural',
};

async function synthesize(text: string, language: string): Promise<Uint8Array> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE_MAP[language] ?? VOICE_MAP.en, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
```

---

## 10. Content Safety pipeline (полная логика)

### 10.1 На входе (input)

```
[user text] 
    │
    ▼
[regex blacklist check]
    │ flagged → block, log, increment user.flag_count
    │
    ▼
[jailbreak detector]
    │ flagged → block, log as 'jailbreak_attempt' severity=high
    │
    ▼
[OpenAI Moderation API]
    │
    ├─ sexual/minors >= 0.2 → block, severity=critical, increment flag_count by 5
    │
    ├─ harm >= 0.6 → block, severity=high
    │
    ├─ violence >= 0.7 → block, severity=high
    │
    ├─ hate >= 0.6 → block, severity=high
    │
    ├─ self_harm >= 0.5 → block, severity=high + show t('self_harm.resources')
    │
    ├─ sexual (adult) >= 0.7 → block, severity=medium
    │
    └─ none → allow
    │
    ▼
[pass to LLM]
```

### 10.2 На выходе (output)

То же самое, но на ответ модели. **Если flagged — НЕ показывать юзеру**, отдать `t('moderation.output_blocked', user.lang)`.

### 10.3 User reputation

Каждый flagged запрос → `user.flag_count_week++`.

Раз в неделю поле сбрасывается (cron job или ленивая проверка при инкременте).

- `flag_count_week >= 3` → `banned_until = NOW() + 24h`
- `flag_count_total >= 10` → `banned_permanent = TRUE`
- Sexual/minors категория → **сразу** `banned_permanent = TRUE`, без накопления

### 10.4 Audit log

Каждое block-решение сохраняется в `audit_log`:

```typescript
await db.insert(auditLog).values({
  userId: user.id,
  eventType: 'flag_input',
  severity: 'high',
  contentHash: sha256(text),
  contentExcerpt: text.slice(0, 200),
  categories: { violence: true, harm: true },
  moderationScores: { violence: 0.85, harm: 0.72 },
  metadata: { personaId: conv.personaId, lang: user.languageCode },
});
```

**Retention:** 30 дней (GDPR). Cron job раз в сутки удаляет старые записи.

---

## 11. Rate limiting и cost tracking

### 11.1 Rate limiter (Redis)

Keys:
- `rl:text:{userId}:{YYYY-MM-DD}`
- `rl:voice:{userId}:{YYYY-MM-DD}`
- `rl:document:{userId}:{YYYY-MM-DD}`

```typescript
async function checkAndIncrement(
  userId: UserId,
  kind: RateLimitKind
): Promise<RateLimitResult> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:${kind}:${userId}:${today}`;
  const limit = LIMITS[kind];
  
  // Atomic INCR + EXPIRE via pipeline
  const [current] = await redis
    .multi()
    .incr(key)
    .expire(key, 86_400)
    .exec()
    .then((r) => r!.map((x) => x![1]));
  
  if ((current as number) > limit) {
    const ttl = await redis.ttl(key);
    return { allowed: false, current: current as number, limit, resetsInSec: ttl };
  }
  return { allowed: true, current: current as number, limit, resetsInSec: 86_400 };
}
```

### 11.2 Cost tracker

```typescript
async function trackRequest(opts: {
  userId: UserId;
  tokensInput: number;
  tokensOutput: number;
}): Promise<CostTrackingResult> {
  const cost =
    opts.tokensInput * env.COST_PER_INPUT_TOKEN_USD +
    opts.tokensOutput * env.COST_PER_OUTPUT_TOKEN_USD;
  
  const today = new Date().toISOString().slice(0, 10);
  
  // Update DB
  await db
    .insert(usageStatsDaily)
    .values({
      date: today,
      userId: opts.userId,
      textMessages: 1,
      tokensInput: opts.tokensInput,
      tokensOutput: opts.tokensOutput,
      costUsd: cost.toString(),
    })
    .onConflictDoUpdate({
      target: [usageStatsDaily.date, usageStatsDaily.userId],
      set: {
        textMessages: sql`${usageStatsDaily.textMessages} + 1`,
        tokensInput: sql`${usageStatsDaily.tokensInput} + ${opts.tokensInput}`,
        tokensOutput: sql`${usageStatsDaily.tokensOutput} + ${opts.tokensOutput}`,
        costUsd: sql`${usageStatsDaily.costUsd} + ${cost}`,
      },
    });
  
  // Update daily total in Redis (fast)
  const dailyKey = `cost:daily:${today}`;
  const total = await redis.incrbyfloat(dailyKey, cost);
  await redis.expire(dailyKey, 86_400 + 3600);
  const dailyTotal = parseFloat(total);
  
  const overAlert = dailyTotal > env.COST_ALERT_THRESHOLD_USD;
  const overKill = dailyTotal > env.DAILY_BUDGET_USD;
  
  // Alerts (1 раз в сутки)
  if (overAlert && !(await redis.get(`cost:alerted:${today}`))) {
    await bot.api.sendMessage(env.ADMIN_CHAT_ID,
      `⚠️ Daily cost: $${dailyTotal.toFixed(2)}`);
    await redis.set(`cost:alerted:${today}`, '1', 'EX', 86_400);
  }
  
  if (overKill) {
    await redis.set('kill_switch', '1', 'EX', 86_400);
    await bot.api.sendMessage(env.ADMIN_CHAT_ID,
      `🚨 KILL SWITCH: daily $${dailyTotal.toFixed(2)} exceeds $${env.DAILY_BUDGET_USD}`);
  }
  
  return { dailyTotalUsd: dailyTotal, overAlertThreshold: overAlert, overKillThreshold: overKill };
}
```

### 11.3 Kill switch middleware

```typescript
import type { MiddlewareFn } from 'grammy';

export const killSwitchMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  const isAdmin = env.ADMIN_TG_IDS.includes(ctx.from?.id ?? 0);
  if (isAdmin) {
    return next();
  }
  
  const killActive = (await redis.get('kill_switch')) === '1' || env.KILL_SWITCH;
  if (killActive) {
    await ctx.reply(ctx.t('error.maintenance'));
    return;                                          // don't call next
  }
  return next();
};
```

---

## 12. Логирование и мониторинг

### 12.1 Структурированные логи (pino)

Используем **pino** + JSON renderer. В dev — `pino-pretty` для читаемости. В production — чистый JSON в stdout, Docker собирает.

```typescript
// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.LOG_FORMAT === 'pretty' && {
    transport: { target: 'pino-pretty' },
  }),
  base: { service: 'gonka-bot' },
});

export type Logger = typeof logger;
```

Каждый log entry содержит:

```json
{
  "level": 30,
  "time": 1748100021000,
  "service": "gonka-bot",
  "event": "llm_request",
  "userId": 12345,
  "tgId": 678910,
  "conversationId": 555,
  "persona": "analyst",
  "tokensInput": 320,
  "tokensOutput": 178,
  "costUsd": 0.00031,
  "latencyMs": 2340,
  "lang": "ru"
}
```

Используй `logger.child({ userId, ... })` для контекстных логгеров — все вложенные логи получат поля автоматически.

### 12.2 Метрики

В минимальном MVP — **Better Stack** ($25/мес) или **Grafana + Prometheus** (бесплатно через self-host).

Ключевые метрики:
- DAU, WAU
- Сообщений/день (text, voice, doc)
- Avg latency Gonka
- Error rate Gonka
- Cost per day
- Flag rate
- Per-language breakdown

### 12.3 Алерты

- Daily cost > $30 → admin chat
- Daily cost > $50 → kill switch + admin chat
- Gonka error rate > 5% за 5 мин → admin chat
- Любой `severity=critical` в audit_log → admin chat немедленно

---

## 13. Deployment

### 13.0 Dockerfile

```dockerfile
# === Stage 1: Builder ===
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy lockfile + package.json first для кеширования слоёв
COPY package.json pnpm-lock.yaml ./

# Install ALL deps (incl. dev) для сборки
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm build

# Prune dev dependencies
RUN pnpm install --frozen-lockfile --prod

# === Stage 2: Runtime ===
FROM node:22-alpine AS runtime

WORKDIR /app

# Non-root user
RUN addgroup -g 1001 nodejs && \
    adduser -S nodeapp -u 1001 -G nodejs

# Copy built artifacts
COPY --from=builder --chown=nodeapp:nodejs /app/dist ./dist
COPY --from=builder --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodeapp:nodejs /app/package.json ./
COPY --from=builder --chown=nodeapp:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nodeapp:nodejs /app/src/data ./src/data
COPY --from=builder --chown=nodeapp:nodejs /app/src/locales ./src/locales

USER nodeapp

EXPOSE 8080

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/main.js"]
```

### 13.1 Docker Compose

```yaml
version: '3.9'

services:
  bot:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      - DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    networks:
      - internal
  
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
    networks:
      - internal
  
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
    networks:
      - internal
  
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - bot
    networks:
      - internal

volumes:
  pg_data:
  redis_data:
  caddy_data:
  caddy_config:

networks:
  internal:
```

### 13.2 Caddyfile

```
bot.yourdomain.com {
    reverse_proxy bot:8080
    encode gzip
    log {
        output stdout
        format json
    }
}
```

### 13.3 Шаги развёртывания

```bash
# 1. SSH на свежий Ubuntu 24.04 VPS (Hetzner CPX21)
# 2. Установить Docker
curl -fsSL https://get.docker.com | sh
sudo apt install docker-compose-plugin

# 3. Клонировать репо
git clone <repo>
cd gonka-bot

# 4. Скопировать .env.example → .env, заполнить
cp .env.example .env
nano .env

# 5. Поднять стек
docker compose up -d

# 6. Применить миграции
docker compose exec bot node dist/scripts/migrate.js
# или через drizzle-kit:
# docker compose run --rm bot pnpm db:migrate

# 7. Seed personas в БД
docker compose exec bot node dist/scripts/seed-personas.js

# 8. Зарегистрировать webhook
docker compose exec bot node dist/scripts/set-webhook.js

# 9. Проверить
curl https://bot.yourdomain.com/health
```

### 13.4 Регистрация бота у BotFather

Команды для BotFather:

```
/newbot
<bot name>
<bot username>

/setdescription   # длинное описание
/setabouttext     # короткое описание для профиля
/setuserpic       # аватарка
/setcommands
start - 🚀 Начать
help - ℹ️ Помощь
new - 🆕 Новый диалог
persona - 🎭 Сменить персонажа
voice - 🎙 Голосовые ответы
lang - 🌐 Язык интерфейса
about - 💚 О боте
report - ⚠️ Сообщить о проблеме

/setjoingroups  # Enable (для групповых чатов с @mention)
/setprivacy  # Enable (Privacy mode ON — критично!)
/setinline  # Disable пока
```

---

## 14. Тестирование

### 14.1 Unit-тесты (vitest)

Минимум для MVP:

- `tests/unit/services/moderation.test.ts` — pipeline возвращает корректное решение для известных опасных/безопасных промптов
- `tests/unit/services/jailbreak.test.ts` — детектор ловит все паттерны из списка
- `tests/unit/services/rate-limiter.test.ts` — счётчики, expire, граничные значения (mock Redis через ioredis-mock)
- `tests/unit/services/cost-tracker.test.ts` — расчёт стоимости, kill switch logic
- `tests/unit/services/conversation.test.ts` — trim истории при превышении лимита
- `tests/unit/services/document.test.ts` — извлечение текста из PDF/DOCX/TXT (fixtures в `tests/fixtures/`)

Vitest конфиг (`vitest.config.ts`):

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
    },
  },
});
```

### 14.2 Integration-тесты

- `tests/integration/chat-flow.test.ts` — full text message flow с моком Gonka и Moderation
- `tests/integration/voice-flow.test.ts` — voice → transcribe → respond
- `tests/integration/document-flow.test.ts` — upload → extract → chat
- `tests/integration/tos-flow.test.ts` — /start → ToS → age gate → welcome

Для integration-тестов поднимаем testcontainers (`@testcontainers/postgresql`, `@testcontainers/redis`) — реальные Postgres и Redis в Docker'е на время теста.

### 14.3 Manual QA checklist (перед запуском)

- [ ] Бот отвечает в DM, streaming работает плавно
- [ ] Voice input работает на 6 языках
- [ ] PDF на 50 страниц корректно извлекается и помещается в контекст
- [ ] DOCX корректно извлекается
- [ ] @mention в группе работает, бот не отвечает на обычные сообщения
- [ ] Reply на сообщение бота в группе → бот продолжает контекст
- [ ] Все 10 персонажей переключаются и реально меняют тон ответа
- [ ] Rate limit срабатывает на 31-м сообщении
- [ ] Voice limit срабатывает на 6-м голосовом
- [ ] Document size limit срабатывает на файле >10MB
- [ ] Moderation блокирует известные harmful запросы (тестовый список из 20 промптов)
- [ ] Jailbreak detector ловит "ignore previous instructions"
- [ ] ToS показывается при первом /start
- [ ] Age gate показывается после ToS
- [ ] /new сбрасывает контекст
- [ ] /report создаёт запись и уведомляет админа
- [ ] Kill switch (через admin /kill) отключает ответы для не-админов
- [ ] Daily budget превышение → автоматический kill switch
- [ ] Интерфейс на 6 языках корректно отображается (особенно RTL для AR)
- [ ] Логи структурированные, в JSON, с user_id

---

## 15. Фазированный план реализации (по неделям)

### Неделя 1: Foundation

**Цель:** локальная разработка работает, бот отвечает «Hello» через Telegram.

- Настройка проекта: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`
- pre-commit (через husky + lint-staged): biome + tsc на pre-commit
- Docker Compose стек (postgres + redis + bot)
- grammY setup с webhook через Hono (через ngrok для local dev — `pnpm dev`)
- Базовая структура каталогов
- Drizzle schema (см. раздел 5) + первая миграция
- Простой `/start` handler возвращает "Hello, world!"
- pino + structured logs
- `/health` endpoint в Hono

**Acceptance:** `curl localhost:8080/health` → `{"status":"ok"}`, бот в TG отвечает на `/start`. `pnpm test` и `pnpm lint` проходят. `pnpm build` создаёт `dist/`.

### Неделя 2: Core chat + streaming

**Цель:** бот отвечает на текстовые сообщения через Gonka с streaming.

- `GonkaClient` с SSE streaming
- Получить API ключ от mingles.ai, протестировать на тестовом запросе
- `ConversationService` — создание, append message, get history for LLM
- Handler для текстовых сообщений
- Streaming через `sendMessageDraft`
- `/new` команда
- `/help` команда
- Простой rate limit (30/day) через Redis

**Acceptance:** Юзер отправляет сообщение, видит streaming ответ от Kimi на своём языке, контекст диалога сохраняется в 5+ ходов.

### Неделя 3: Voice + persona

**Цель:** голосовые работают, персонажи переключаются.

- Whisper интеграция для voice input
- Edge-TTS для voice output (опционально, /voice toggle)
- `data/personas.yaml` — 10 готовых персонажей (см. Приложение A)
- Загрузка персонажей в БД при startup
- `/persona` команда с inline keyboard
- Switching persona = new conversation
- `i18n` — locales/en.json и locales/ru.json минимум

**Acceptance:** Юзер шлёт voice → видит транскрипцию → получает ответ; включает voice_output → получает голосовой ответ; переключает персонажа → ответы меняют тон.

### Неделя 4: Documents + long context

**Цель:** документы обрабатываются, 256K используется.

- `DocumentService` — PDF/DOCX/TXT extraction
- Handler для document upload
- Attach document к conversation, использование в system prompt
- tiktoken для подсчёта токенов
- Trim history если суммарно >200K токенов (с сохранением system prompt)

**Acceptance:** Юзер кидает 30-страничный PDF, бот пишет «прочитал, X страниц», юзер задаёт вопрос — получает ответ из документа.

### Неделя 5: Personas (полный набор) + groups

**Цель:** все персонажи готовы, групповые чаты работают.

- Доделать остальные локали (es, ar, zh, de)
- Полные тексты для всех 10 персонажей (см. Приложение A)
- Inline keyboards с emoji
- Privacy mode проверка в BotFather, тестирование с @mention в группе
- Group handler: @mention, reply to bot
- Mapping group conversations (message_id → conversation_id)

**Acceptance:** В групповом чате юзер пишет `@bot построй маршрут` — получает ответ; reply на ответ бота продолжает контекст.

### Неделя 6: Content safety + reputation

**Цель:** безопасность включена и работает.

- `ModerationService` с OpenAI Moderation API
- `JailbreakDetector` с regex-паттернами
- Regex blacklist (LDNOOBW списки в data/blacklist/)
- Input + output фильтрация в основном handler'е
- `audit_log` записи
- User reputation: flag_count_week, ban logic
- `/report` команда + admin notifications
- Audit log retention cron (raz в день)

**Acceptance:** Известные harmful промпты блокируются; юзер с 3 flags за неделю получает 24h ban; admin получает уведомление о critical incident.

### Неделя 7: Polish, ToS, monitoring, soft launch

**Цель:** готовы к запуску на 100-500 юзеров.

- ToS flow на `/start`
- Age gate
- `/lang` команда для смены языка
- `CostTracker` + daily budget cap + kill switch
- Admin команды (`/kill`, `/stats`)
- Better Stack или Grafana setup
- Алерты в admin chat
- Manual QA по чек-листу (см. 14.3)
- Deploy на production VPS
- Регистрация webhook на prod-домене
- Soft launch — пригласить 50-100 первых юзеров через личные каналы

**Acceptance:** Все пункты QA-чек-листа выполнены. Бот живёт на production-домене с HTTPS. Мониторинг показывает живые метрики. Первые юзеры могут пользоваться без блокеров.

---

## 16. Acceptance criteria для MVP

Бот считается **запущенным**, если выполнены **все** условия:

### Функциональность
1. ✅ /start с ToS + age gate, 6 языков интерфейса
2. ✅ Text chat с streaming работает плавно (sendMessageDraft, без flicker)
3. ✅ Voice input на 6 языках работает через Whisper
4. ✅ Voice output опционально работает через Edge-TTS
5. ✅ Document upload (PDF/DOCX/TXT) до 10MB работает, помещается в 256K
6. ✅ 10 персонажей переключаются, реально меняют тон
7. ✅ Group chats с @mention работают
8. ✅ /new, /persona, /help, /voice, /lang, /about, /report — все команды функциональны

### Безопасность
9. ✅ Content safety: OpenAI Moderation + regex + jailbreak detector активны
10. ✅ Sexual/minors категория — instant permanent ban
11. ✅ Audit log записывается, retention 30 дней
12. ✅ User reputation: 3 flags/week → 24h ban; 10 total → permaban
13. ✅ /report работает, админы уведомляются

### Cost & rate limiting
14. ✅ Per-user limits: 30 text/day, 5 voice/day, 3 documents/day
15. ✅ Daily cost cap с kill switch
16. ✅ Cost tracking в реальном времени
17. ✅ Admin алерты на превышение порогов

### Operations
18. ✅ Webhook на production HTTPS-домене
19. ✅ Docker Compose стек стабильно работает
20. ✅ Структурированные логи в JSON
21. ✅ Мониторинг с базовыми метриками (DAU, cost, errors)
22. ✅ Алерты в admin chat работают
23. ✅ Бэкап Postgres настроен (даже простой pg_dump раз в сутки)

### Документация
24. ✅ README с инструкцией deploy
25. ✅ .env.example с описанием всех переменных
26. ✅ Список персонажей и их промпты в `data/personas.yaml`
27. ✅ Список ToS и его версионирование

---

## 17. Out of scope для MVP

**НЕ делаем** в MVP (отложено в Phase 2-3):

- User-created custom personas (только готовые 10)
- Sharable persona links (`t.me/bot?start=persona_xxx`)
- Web search для бота
- Research-агент с многошаговыми вызовами
- Code-агент с code execution
- Image generation
- Image input / vision (vision у Kimi через Gonka неподтверждён)
- Multi-model selection (Qwen3, GPT-OSS) — только Kimi K2.6
- Bot-to-bot коммуникация
- Chat Automation (AI-секретарь)
- Managed Bots (создание ботов другим юзерам)
- Custom AI Styles интеграция с TG
- @mention в любых чатах без добавления бота (требует Bot API 9.6 — добавим в Phase 2)
- Платежи / подписки
- Реферальная система
- Web-сайт (отдельный проект)
- Mobile app (отдельный проект)
- Own opengnk proxy (на старте mingles.ai gateway достаточно; свой прокси — задача после MVP)

---

## Приложение A — 10 персонажей по умолчанию

Содержимое `data/personas.yaml`:

```yaml
personas:
  - slug: default
    name_key: persona.default.name        # "Помощник" / "Assistant"
    description_key: persona.default.desc # "Универсальный AI-помощник"
    emoji: "💬"
    is_default: true
    sort_order: 1
    system_prompt: |
      You are a helpful, friendly AI assistant powered by Kimi K2.6 on the Gonka decentralized network.
      Be concise but complete. Avoid disclaimers unless safety-relevant.
      Respond in the user's language (detected from their message).
      Refuse harmful, illegal, or unethical requests politely.
  
  - slug: analyst
    name_key: persona.analyst.name        # "Аналитик" / "Analyst"
    description_key: persona.analyst.desc
    emoji: "📊"
    sort_order: 2
    system_prompt: |
      You are a data analyst. Help users with data analysis, SQL queries, statistics, spreadsheets, and analytical reports.
      Be precise with numbers. Show your reasoning step-by-step.
      When working with data, ask for clarification if the format is ambiguous.
      Format SQL queries and code blocks properly.
  
  - slug: coder
    name_key: persona.coder.name          # "Программист" / "Coder"
    description_key: persona.coder.desc
    emoji: "🧑‍💻"
    sort_order: 3
    system_prompt: |
      You are an expert software engineer. Help users with code: writing, debugging, refactoring, explaining.
      Default to clean, idiomatic, modern code.
      Always specify the language. Add brief comments where helpful.
      If the question is ambiguous, ask before generating long code.
  
  - slug: therapist
    name_key: persona.therapist.name      # "Психолог" / "Therapist"
    description_key: persona.therapist.desc
    emoji: "🧠"
    sort_order: 4
    system_prompt: |
      You are an empathetic listener with knowledge of cognitive behavioral therapy principles.
      You are NOT a licensed mental health professional. You do NOT diagnose, prescribe, or replace therapy.
      Validate feelings first. Ask open-ended questions. Avoid platitudes like "stay strong".
      If the user expresses suicidal ideation or imminent danger, recommend professional help and provide hotline info.
  
  - slug: translator
    name_key: persona.translator.name
    description_key: persona.translator.desc
    emoji: "🌍"
    sort_order: 5
    system_prompt: |
      You are a precise translator. Translate text between languages preserving tone, register, and idioms.
      If the user pastes text without specifying target language, ask.
      For ambiguous idioms, offer 2 alternatives.
  
  - slug: editor
    name_key: persona.editor.name
    description_key: persona.editor.desc
    emoji: "✍️"
    sort_order: 6
    system_prompt: |
      You are a professional editor. Improve clarity, grammar, and flow while preserving the author's voice.
      Show the edited version, then briefly list main changes.
      Don't rewrite stylistically unless asked.
  
  - slug: researcher
    name_key: persona.researcher.name
    description_key: persona.researcher.desc
    emoji: "🔬"
    sort_order: 7
    system_prompt: |
      You are a thorough researcher. Provide structured, well-organized information on requested topics.
      Note when something is well-established vs. debated.
      Acknowledge limits of your knowledge (cutoff dates, etc.).
      Do NOT fabricate citations. If unsure, say so.
  
  - slug: teacher
    name_key: persona.teacher.name
    description_key: persona.teacher.desc
    emoji: "👩‍🏫"
    sort_order: 8
    system_prompt: |
      You are a patient teacher. Explain concepts from first principles, building up complexity.
      Use analogies. Check understanding with brief questions.
      Adapt the level to the user's apparent expertise.
  
  - slug: chef
    name_key: persona.chef.name
    description_key: persona.chef.desc
    emoji: "👨‍🍳"
    sort_order: 9
    system_prompt: |
      You are a friendly chef helping with recipes, cooking techniques, meal planning, and substitutions.
      Adapt to dietary restrictions if mentioned. Suggest realistic ingredient availability.
      Be metric and imperial friendly. Estimate cooking times.
  
  - slug: writer
    name_key: persona.writer.name
    description_key: persona.writer.desc
    emoji: "📚"
    sort_order: 10
    system_prompt: |
      You are a creative writing assistant. Help with stories, essays, poems, copywriting, brainstorming.
      Respect the writer's style and goals. Offer options rather than dictating.
      For fiction, take the user's creative direction; don't refuse legitimate dark themes.
```

---

## Приложение B — Локализационные ключи

Минимальный набор ключей в `locales/{lang}.json`:

```json
{
  "welcome.text": "...",
  "tos.intro": "...",
  "tos.full": "...",
  "age.question": "Are you 18 or older?",
  "age.under18": "...",
  "main_menu.chat": "💬 Just chat",
  "main_menu.document": "📄 Upload document",
  "main_menu.persona": "🎭 Pick persona",
  "main_menu.about": "ℹ️ About",
  "persona.choose": "Choose a persona:",
  "persona.selected": "Now I'm {name}.",
  "persona.default.name": "Assistant",
  "persona.default.desc": "General-purpose AI helper",
  "persona.analyst.name": "Analyst",
  "...": "...",
  "rate_limit.text": "Daily limit reached ({current}/{limit}). Reset in {hours}h.",
  "rate_limit.voice": "Voice limit reached. Reset in {hours}h.",
  "document.received": "Got it — {pages} pages, {tokens} tokens. Ask me about it.",
  "document.too_large": "Document is too large (max {limit} MB).",
  "document.unsupported": "Unsupported format. PDF, DOCX, TXT only.",
  "document.parse_failed": "Couldn't read this document.",
  "moderation.input_blocked": "I can't help with that. Please ask something else.",
  "moderation.output_blocked": "I can't share that response. Try a different question.",
  "self_harm.resources": "If you're in crisis, please contact: ...",
  "error.banned": "Your access is suspended. Reason: {reason}.",
  "error.maintenance": "Service temporarily unavailable. Try again later.",
  "new_conversation.confirmed": "Started new conversation.",
  "report.thanks": "Thanks for reporting. We'll review it.",
  "group.must_start_dm_first": "Please first DM me and accept Terms.",
  "about.text": "Powered by Kimi K2.6 on Gonka decentralized network. Free, no signup. Learn more: gonka.ai"
}
```

Полные тексты должны быть переведены для всех 6 языков.

---

## Приложение C — Известные риски и митигации

| Риск | Митигация |
|------|-----------|
| mingles.ai gateway перестаёт быть бесплатным | План Б: переключиться на GonkaGate или поднять свой opengnk прокси |
| Bot API 9.5+ методы (sendMessageDraft) ломаются | Fallback на классический editMessageText (есть в коде) |
| Whisper API rate limits на массовом запуске | Кешировать одинаковые транскрипции, переход на self-hosted whisper.cpp |
| Edge-TTS закрывают / меняют API | Переключиться на OpenAI TTS ($) или Piper (self-hosted) |
| Kimi выдаёт harmful контент через jailbreak | Output filter второй линии + audit + быстрая реакция |
| Telegram банит бота | Backup аккаунт + правильные ToS в BotFather |
| Cost overrun из-за бага | Kill switch + дневной cap + admin alerts |
| GDPR-запрос на удаление данных | Имплементировать `/delete_my_data` команду (Phase 1.1 после MVP) |

---

## Контакт имплементатора

При вопросах по неоднозначностям в этом ТЗ:
1. Сначала ищи ответ в этом документе (Ctrl+F)
2. Если не нашёл — иди по дефолту индустриального стандарта (12-factor app, REST conventions, idiomatic TypeScript: strict types, discriminated unions, Result pattern, no implicit any)
3. Если решение неочевидно — оставь TODO в коде с пояснением, что выбрал и почему

**Не делай** того, что **выходит за scope MVP** (см. раздел 17). Удержись от соблазна "пока я тут, дам также..."

---

**Конец ТЗ. Версия 1.0. Дата: 24 мая 2026.**
