// ConversationService — orchestrates conversation lifecycle for the chat
// pipeline.
//
// [AUDIT-C6] System prompt is built fresh on every request by the chat
// composer (via PersonaService.renderSystemPrompt). We never persist a
// 'system' row. getMessagesForLlm returns only user/assistant turns.
//
// [AUDIT-N4] startNew() runs deactivate + insert in a single transaction so
// the partial unique index `uniq_user_active_conv` cannot fire even under
// concurrent /new + getOrCreateActive.
//
// [AUDIT-A5] getMessagesForLlm reserves space for system prompt + response
// so a huge attached document can't blow the 256K Kimi context window.

import type { Database } from '../db/client.js';
import type { ConversationsRepository } from '../db/repositories/conversations.js';
import type { MessagesRepository } from '../db/repositories/messages.js';
import type { Conversation } from '../db/schema.js';
import {
  type ConversationId,
  type Logger,
  type MessageId,
  type PersonaId,
  type Result,
  type Tokenizer,
  type UserId,
  err,
  ok,
} from '../types.js';
import { toConversationId, toMessageId, toPersonaId, toUserId } from '../utils/ids.js';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ConversationDomain {
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

function toDomain(row: Conversation): ConversationDomain {
  return {
    id: toConversationId(row.id),
    userId: toUserId(row.userId),
    personaId: row.personaId == null ? null : toPersonaId(row.personaId),
    title: row.title,
    documentText: row.documentText,
    documentName: row.documentName,
    documentTokens: row.documentTokens,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface AppendMessageOpts {
  conversationId: ConversationId;
  role: 'user' | 'assistant';
  content: string;
  tgMessageId?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number | null;
}

export interface GetMessagesForLlmOpts {
  conversationId: ConversationId;
  /** Maximum pairs to consider before trimming. Default 20 (= 40 messages). */
  maxHistory?: number;
  /** Tokens occupied by the rendered system prompt (incl. attached doc). */
  reservedForSystem: number;
  /** Tokens budgeted for the model's reply. Default 4096. */
  reservedForResponse?: number;
  /** Hard upper bound — Kimi K2.6 = 256K. */
  contextWindow?: number;
}

export type GetMessagesForLlmError = { kind: 'document_overflow'; reservedTokens: number };

export interface ConversationService {
  getOrCreateActive(userId: UserId): Promise<ConversationDomain>;
  startNew(
    userId: UserId,
    opts?: { personaId?: PersonaId; groupChatId?: number },
  ): Promise<ConversationDomain>;
  deactivateAllForUser(userId: UserId): Promise<void>;
  setPersona(conversationId: ConversationId, personaId: PersonaId): Promise<void>;
  appendMessage(opts: AppendMessageOpts): Promise<MessageId>;
  getMessagesForLlm(
    opts: GetMessagesForLlmOpts,
  ): Promise<Result<ChatMessage[], GetMessagesForLlmError>>;
  attachDocument(opts: {
    conversationId: ConversationId;
    text: string;
    documentName: string;
    tokens: number;
  }): Promise<void>;
  /** [AUDIT-X7] used by /report when user replies to a bot message. */
  findMessageByTgId(conversationId: ConversationId, tgMessageId: number): Promise<MessageId | null>;
  /** [AUDIT-X7] fallback for /report without reply target. */
  lastAssistantMessage(conversationId: ConversationId): Promise<MessageId | null>;
}

export interface ConversationServiceDeps {
  db: Database;
  conversations: ConversationsRepository;
  messages: MessagesRepository;
  tokenizer: Tokenizer;
  logger: Logger;
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  return {
    async getOrCreateActive(userId) {
      const existing = await deps.conversations.findActiveByUser(userId);
      if (existing) return toDomain(existing);
      return this.startNew(userId);
    },

    async startNew(userId, opts) {
      // [AUDIT-N4] DM conversations are deactivated transactionally before
      // we insert a fresh active row. Group conversations don't participate
      // in the partial unique index, so we skip the deactivate there.
      const isGroup = opts?.groupChatId != null;
      const created = await deps.db.transaction(async (tx) => {
        if (!isGroup) {
          await deps.conversations.deactivateActiveDmTx(tx, userId);
        }
        return deps.conversations.insertActiveTx(tx, {
          userId,
          personaId: opts?.personaId ?? null,
          groupChatId: opts?.groupChatId ?? null,
        });
      });
      deps.logger.info({ userId, convId: created.id, group: isGroup }, 'conversation_started');
      return toDomain(created);
    },

    async deactivateAllForUser(userId) {
      // Single-tx call — re-uses the repository helper. No insert.
      await deps.db.transaction(async (tx) => {
        await deps.conversations.deactivateActiveDmTx(tx, userId);
      });
    },

    async setPersona(conversationId, personaId) {
      await deps.conversations.update(conversationId, { personaId: personaId as number });
    },

    async appendMessage(opts) {
      const row = await deps.messages.append({
        conversationId: opts.conversationId as number,
        role: opts.role,
        content: opts.content,
        ...(opts.tgMessageId !== undefined ? { tgMessageId: opts.tgMessageId } : {}),
        ...(opts.tokensInput !== undefined ? { tokensInput: opts.tokensInput } : {}),
        ...(opts.tokensOutput !== undefined ? { tokensOutput: opts.tokensOutput } : {}),
        ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
      });
      return toMessageId(row.id);
    },

    async getMessagesForLlm(opts) {
      const maxHistory = opts.maxHistory ?? 20;
      const reservedForResponse = opts.reservedForResponse ?? 4096;
      const contextWindow = opts.contextWindow ?? 256_000;
      const safetyBuffer = 4096;

      // [AUDIT-A5] If the rendered system prompt alone leaves no room, the
      // attached document is too big for this model — abort early so chat.ts
      // can show document.too_long to the user.
      if (opts.reservedForSystem + reservedForResponse + safetyBuffer >= contextWindow) {
        return err({
          kind: 'document_overflow',
          reservedTokens: opts.reservedForSystem,
        });
      }
      const budget = contextWindow - opts.reservedForSystem - reservedForResponse - safetyBuffer;

      // Pull last `maxHistory * 2` rows (we count by message, not by pair).
      const rows = await deps.messages.recent(opts.conversationId as number, maxHistory * 2);

      // Trim oldest first, in pairs, until under budget.
      // Pairs are formed by walking from the end backwards: an 'assistant'
      // anchors a pair with its preceding 'user'. Orphan messages are
      // dropped if they fall outside a pair.
      const trimmed = trimToBudget(rows, budget, (m) => deps.tokenizer.estimate(m.content));
      return ok(trimmed.map((m) => ({ role: m.role as ChatRole, content: m.content })));
    },

    async attachDocument(opts) {
      await deps.conversations.update(opts.conversationId as number, {
        documentText: opts.text,
        documentName: opts.documentName,
        documentTokens: opts.tokens,
      });
    },

    async findMessageByTgId(conversationId, tgMessageId) {
      const m = await deps.messages.findByTgMessageId(conversationId as number, tgMessageId);
      return m ? toMessageId(m.id) : null;
    },

    async lastAssistantMessage(conversationId) {
      const m = await deps.messages.lastAssistant(conversationId as number);
      return m ? toMessageId(m.id) : null;
    },
  };
}

// ===== helpers =====

/**
 * Walk the message list oldest-first and keep adding messages while the
 * accumulated token estimate stays under budget. Pairs (user+assistant) are
 * dropped together — never leave an orphan assistant without its user prompt,
 * which confuses chat models.
 */
function trimToBudget<T extends { role: string; content: string }>(
  msgs: T[],
  budget: number,
  countTokens: (msg: T) => number,
): T[] {
  if (msgs.length === 0) return msgs;

  // Build pair groups walking from the end backwards.
  const groups: T[][] = [];
  let i = msgs.length - 1;
  while (i >= 0) {
    const m = msgs[i];
    if (!m) {
      i -= 1;
      continue;
    }
    if (m.role === 'assistant' && i > 0) {
      const prev = msgs[i - 1];
      if (prev && prev.role === 'user') {
        groups.unshift([prev, m]);
        i -= 2;
        continue;
      }
    }
    // Orphan or unexpected role — keep as a singleton group.
    groups.unshift([m]);
    i -= 1;
  }

  // Walk groups newest-first; drop oldest groups until under budget.
  let total = 0;
  const sized = groups.map((group) => ({
    group,
    tokens: group.reduce((acc, m) => acc + countTokens(m), 0),
  }));
  // newest-first
  const reversed = [...sized].reverse();
  const keepReversed: typeof sized = [];
  for (const entry of reversed) {
    if (total + entry.tokens > budget) break;
    keepReversed.push(entry);
    total += entry.tokens;
  }
  return keepReversed.reverse().flatMap((e) => e.group);
}
