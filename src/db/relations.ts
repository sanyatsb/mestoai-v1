// [AUDIT-M4] Drizzle relations for type-safe joins via the relational query
// builder (db.query.users.findFirst({ with: { conversations: true } })).

import { relations } from 'drizzle-orm';
import { auditLog, conversations, messages, personas, userReports, users } from './schema.js';

export const usersRelations = relations(users, ({ many, one }) => ({
  conversations: many(conversations),
  activePersona: one(personas, {
    fields: [users.activePersonaId],
    references: [personas.id],
  }),
  activeConversation: one(conversations, {
    fields: [users.activeConversationId],
    references: [conversations.id],
    relationName: 'activeConversation',
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
