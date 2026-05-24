-- [AUDIT-M11, N4] Partial unique index — Drizzle cannot express this via
-- pgTable yet, so we manage it as a custom migration.
--
-- Invariant: at most one active conversation per user in DMs (group chats
-- are excluded because they can legitimately have many in-flight threads).
-- This is the constraint that lets ConversationService.startNew() rely on
-- a transactional deactivate-then-insert without racing with
-- getOrCreateActive() and producing duplicates.

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_active_conv"
  ON "conversations"("user_id")
  WHERE "is_active" = true AND "group_chat_id" IS NULL;
