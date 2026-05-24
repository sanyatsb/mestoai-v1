// conversations repository — DB access for conversations table.
// [AUDIT-N4] startNewTx + deactivateActiveDmTx are exposed so the
// ConversationService can wrap them in a single db.transaction().

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { Database } from '../client.js';
import { type Conversation, conversations } from '../schema.js';

/** A Drizzle transaction handle. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ConversationsRepository {
  findActiveByUser(userId: number): Promise<Conversation | undefined>;

  /**
   * [AUDIT-N4] Deactivate all active DM conversations for this user.
   * MUST be used inside a transaction together with insertActive() to
   * avoid violating the partial unique index uniq_user_active_conv.
   */
  deactivateActiveDmTx(tx: Tx, userId: number): Promise<void>;

  /** Inside-tx counterpart to insert a fresh active row. */
  insertActiveTx(
    tx: Tx,
    row: {
      userId: number;
      personaId: number | null;
      groupChatId: number | null;
    },
  ): Promise<Conversation>;

  /** Update arbitrary fields (used by attachDocument / setPersona / etc.). */
  update(id: number, patch: Partial<Conversation>): Promise<void>;
}

export function createConversationsRepository(db: Database): ConversationsRepository {
  return {
    async findActiveByUser(userId) {
      const rows = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.userId, userId),
            eq(conversations.isActive, true),
            isNull(conversations.groupChatId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async deactivateActiveDmTx(tx, userId) {
      await tx
        .update(conversations)
        .set({ isActive: false, updatedAt: sql`NOW()` })
        .where(
          and(
            eq(conversations.userId, userId),
            eq(conversations.isActive, true),
            isNull(conversations.groupChatId),
          ),
        );
    },

    async insertActiveTx(tx, row) {
      const [created] = await tx
        .insert(conversations)
        .values({
          userId: row.userId,
          personaId: row.personaId,
          groupChatId: row.groupChatId,
          isActive: true,
        })
        .returning();
      if (!created) throw new Error('conversations.insertActiveTx returned no row');
      return created;
    },

    async update(id, patch) {
      await db
        .update(conversations)
        .set({ ...patch, updatedAt: sql`NOW()` })
        .where(eq(conversations.id, id));
    },
  };
}

// Re-export the Tx type so services can name it.
export type { Tx };
// Avoid an "unused import" lint hit on PgTransaction by re-exporting.
export type { PgTransaction };
