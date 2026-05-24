// We don't need the full ConversationService here — the interesting bit is
// the trim algorithm. The simplest way to validate it is to spy on a stub
// MessagesRepository and assert what arrives at getMessagesForLlm.

import { describe, expect, it } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import type { ConversationsRepository } from '../../../src/db/repositories/conversations.js';
import type { MessagesRepository } from '../../../src/db/repositories/messages.js';
import type { Message } from '../../../src/db/schema.js';
import { createConversationService } from '../../../src/services/conversation.js';
import type { ConversationId, Tokenizer } from '../../../src/types.js';
import { toConversationId } from '../../../src/utils/ids.js';

const silentLogger = {
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino-like stub
} as any;

function makeMsg(
  role: 'user' | 'assistant',
  content: string,
  id: number,
  createdAt: Date,
): Message {
  return {
    id,
    conversationId: 1,
    role,
    content,
    tgMessageId: null,
    tokensInput: null,
    tokensOutput: null,
    costUsd: null,
    createdAt,
  };
}

// One token per 4 chars — easy to reason about for fixture sizes.
const tokenizer: Tokenizer = {
  estimate: (text) => Math.ceil(text.length / 4),
};

function makeService(rows: Message[]) {
  const messages: MessagesRepository = {
    append: async () => {
      const first = rows[0];
      if (!first) throw new Error('append() called but no fixture rows');
      return { ...first };
    },
    recent: async (_conv, limit) => rows.slice(-limit).map((r) => ({ ...r })),
    findByTgMessageId: async () => undefined,
    lastAssistant: async () => undefined,
  };
  const conversations: ConversationsRepository = {
    findActiveByUser: async () => undefined,
    deactivateActiveDmTx: async () => undefined,
    insertActiveTx: async () => {
      throw new Error('not used');
    },
    update: async () => undefined,
  };
  // db is never reached in these tests.
  const db = {} as Database;
  return createConversationService({
    db,
    conversations,
    messages,
    tokenizer,
    logger: silentLogger,
  });
}

describe('ConversationService.getMessagesForLlm', () => {
  const convId: ConversationId = toConversationId(1);

  it('returns all messages when under budget', async () => {
    const rows = [
      makeMsg('user', 'hi', 1, new Date('2026-05-25T10:00:00Z')),
      makeMsg('assistant', 'hello there', 2, new Date('2026-05-25T10:00:01Z')),
    ];
    const svc = makeService(rows);
    const r = await svc.getMessagesForLlm({
      conversationId: convId,
      reservedForSystem: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(2);
      expect(r.value[0]?.role).toBe('user');
    }
  });

  it('drops oldest pair (user+assistant) when over budget', async () => {
    const rows = [
      // Oldest pair — should be dropped
      makeMsg('user', 'a'.repeat(400), 1, new Date('2026-05-25T10:00:00Z')),
      makeMsg('assistant', 'b'.repeat(400), 2, new Date('2026-05-25T10:00:01Z')),
      // Newest pair — should stay
      makeMsg('user', 'c'.repeat(40), 3, new Date('2026-05-25T11:00:00Z')),
      makeMsg('assistant', 'd'.repeat(40), 4, new Date('2026-05-25T11:00:01Z')),
    ];
    const svc = makeService(rows);
    // Each old message ~100 tokens, each new ~10. Budget: leave only
    // ~60 tokens free for history after reservedForSystem + 4096 response
    // + 4096 buffer.
    const r = await svc.getMessagesForLlm({
      conversationId: convId,
      reservedForSystem: 256_000 - 4096 - 4096 - 60,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(2);
      expect(r.value[0]?.content.startsWith('c')).toBe(true);
      expect(r.value[1]?.content.startsWith('d')).toBe(true);
    }
  });

  it('errors out when reservedForSystem leaves no room', async () => {
    const svc = makeService([]);
    const r = await svc.getMessagesForLlm({
      conversationId: convId,
      reservedForSystem: 250_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('document_overflow');
    }
  });
});
