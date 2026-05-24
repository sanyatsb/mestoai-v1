// messages repository.
//
// [AUDIT-C6] Schema's `role` enum includes 'system' but we only write
// 'user' / 'assistant' from MVP code. System prompt is injected per request
// by chat composer, never persisted.
//
// [AUDIT-X7, X13] tgMessageId is set so /report can find the right message
// from a reply.

import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type Message, messages } from '../schema.js';

export interface NewMessage {
  conversationId: number;
  role: 'user' | 'assistant';
  content: string;
  tgMessageId?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number | null;
}

export interface MessagesRepository {
  append(row: NewMessage): Promise<Message>;
  /** Last N user/assistant pairs ordered oldest → newest. */
  recent(conversationId: number, limit: number): Promise<Message[]>;
  findByTgMessageId(conversationId: number, tgMessageId: number): Promise<Message | undefined>;
  lastAssistant(conversationId: number): Promise<Message | undefined>;
}

export function createMessagesRepository(db: Database): MessagesRepository {
  return {
    async append(row) {
      const [created] = await db
        .insert(messages)
        .values({
          conversationId: row.conversationId,
          role: row.role,
          content: row.content,
          tgMessageId: row.tgMessageId ?? null,
          tokensInput: row.tokensInput ?? null,
          tokensOutput: row.tokensOutput ?? null,
          costUsd: row.costUsd != null ? String(row.costUsd) : null,
        })
        .returning();
      if (!created) throw new Error('messages.append returned no row');
      return created;
    },

    async recent(conversationId, limit) {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(limit);
      // Caller expects oldest-first.
      return rows.reverse();
    },

    async findByTgMessageId(conversationId, tgMessageId) {
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.conversationId, conversationId), eq(messages.tgMessageId, tgMessageId)),
        )
        .limit(1);
      return rows[0];
    },

    async lastAssistant(conversationId) {
      const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      return rows[0];
    },
  };
}
