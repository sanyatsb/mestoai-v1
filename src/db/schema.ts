// Drizzle schema — single source of truth for the database.
//
// Generate migrations: pnpm db:generate
// Apply:               pnpm db:migrate
// Open studio:         pnpm db:studio
//
// One thing Drizzle can't express natively (yet): a PARTIAL unique index.
// We need one on conversations(user_id) WHERE is_active = true AND
// group_chat_id IS NULL — see drizzle/migrations/9999_partial_index.sql.
// [AUDIT-M11, N4]

import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ===== users =====

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tgId: bigint('tg_id', { mode: 'number' }).notNull().unique(),
    tgUsername: text('tg_username'),
    firstName: text('first_name'),
    languageCode: text('language_code').default('en'),

    tosAcceptedAt: timestamp('tos_accepted_at', { withTimezone: true }),
    tosVersion: text('tos_version'),
    ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
    // [AUDIT-H9] block /start retries after rejection
    ageRejectedAt: timestamp('age_rejected_at', { withTimezone: true }),

    activePersonaId: integer('active_persona_id'),
    activeConversationId: bigint('active_conversation_id', { mode: 'number' }),

    flagCountTotal: integer('flag_count_total').default(0).notNull(),
    flagCountWeek: integer('flag_count_week').default(0).notNull(),
    flagCountWeekResetAt: timestamp('flag_count_week_reset_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    bannedUntil: timestamp('banned_until', { withTimezone: true }),
    bannedPermanent: boolean('banned_permanent').default(false).notNull(),
    banReason: text('ban_reason'),

    voiceOutputEnabled: boolean('voice_output_enabled').default(false).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tgIdIdx: uniqueIndex('idx_users_tg_id').on(t.tgId),
    bannedIdx: index('idx_users_banned').on(t.bannedUntil),
  }),
);

// ===== personas =====

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

// ===== conversations =====
// [AUDIT-P5] groupChatId/botMessageId remain in the schema but are reserved
// for Phase 2 group reply-threads. In MVP they stay NULL.

export const conversations = pgTable(
  'conversations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    personaId: integer('persona_id').references(() => personas.id),
    title: text('title'),
    documentText: text('document_text'),
    documentName: text('document_name'),
    documentTokens: integer('document_tokens'),
    isActive: boolean('is_active').default(true).notNull(),
    groupChatId: bigint('group_chat_id', { mode: 'number' }),
    botMessageId: bigint('bot_message_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userActiveIdx: index('idx_conversations_user_active').on(t.userId, t.isActive),
    groupThreadIdx: index('idx_conversations_group_thread').on(t.groupChatId, t.botMessageId),
  }),
);

// ===== messages =====
// [AUDIT-X1] 'system' role is reserved for Phase 2 (system markers in history).
// In MVP we only write 'user' / 'assistant'.
// [AUDIT-X7, X13] tgMessageId is required to find a bot message from a /report
// reply.

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: bigint('conversation_id', { mode: 'number' })
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['system', 'user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    tgMessageId: bigint('tg_message_id', { mode: 'number' }),
    tokensInput: integer('tokens_input'),
    tokensOutput: integer('tokens_output'),
    // [AUDIT-L2] precision raised to 12 to cover longer single-message replies.
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    convIdx: index('idx_messages_conv').on(t.conversationId, t.createdAt),
    tgMsgIdx: index('idx_messages_tg_msg').on(t.tgMessageId),
  }),
);

// ===== audit_log =====
// [AUDIT-B3] userId is nullable so /delete_my_data can anonymize entries
// (security exemption — we keep categories+scores for safety analytics but
// disconnect them from the deleted user).

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
    eventType: text('event_type').notNull(),
    severity: text('severity', { enum: ['low', 'medium', 'high', 'critical'] }).notNull(),
    contentHash: text('content_hash'),
    contentExcerpt: text('content_excerpt'),
    categories: jsonb('categories'),
    moderationScores: jsonb('moderation_scores'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('idx_audit_user').on(t.userId, t.createdAt),
    eventIdx: index('idx_audit_event').on(t.eventType, t.createdAt),
  }),
);

// ===== usage_stats_daily =====

export const usageStatsDaily = pgTable(
  'usage_stats_daily',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    date: text('date').notNull(), // YYYY-MM-DD
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
    textMessages: integer('text_messages').default(0).notNull(),
    voiceMessages: integer('voice_messages').default(0).notNull(),
    documents: integer('documents').default(0).notNull(),
    tokensInput: bigint('tokens_input', { mode: 'number' }).default(0).notNull(),
    tokensOutput: bigint('tokens_output', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).default('0').notNull(),
  },
  (t) => ({
    dateUserIdx: uniqueIndex('idx_usage_date_user').on(t.date, t.userId),
    dateIdx: index('idx_usage_date').on(t.date),
  }),
);

// ===== user_reports =====

export const userReports = pgTable('user_reports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  reporterUserId: bigint('reporter_user_id', { mode: 'number' }).references(() => users.id),
  messageId: bigint('message_id', { mode: 'number' }).references(() => messages.id),
  reason: text('reason'),
  status: text('status', { enum: ['pending', 'reviewed', 'actioned'] })
    .default('pending')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

// ===== inferred row types =====

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Persona = typeof personas.$inferSelect;
export type NewPersona = typeof personas.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type UsageStatsDaily = typeof usageStatsDaily.$inferSelect;
export type UserReport = typeof userReports.$inferSelect;
