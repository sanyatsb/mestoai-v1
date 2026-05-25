// [AUDIT-M7, X12] Tests for extractTextWithoutMention.

import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { extractTextWithoutMention } from '../../../src/utils/extract-mention.js';

// Build a minimal Message stub. grammy/types.Message has a ton of optional
// fields; we only need text + entities + the chat/date scaffolding TS
// requires.
function makeMsg(text: string, entities: Message['entities'] = []): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: 'group', title: 'g' },
    text,
    entities,
  } as Message;
}

describe('extractTextWithoutMention', () => {
  it('strips a trailing @mention', () => {
    const text = 'hello @MyBot';
    const msg = makeMsg(text, [{ type: 'mention', offset: 6, length: 6 }]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('hello');
  });

  it('strips a leading @mention', () => {
    const text = '@MyBot how are you?';
    const msg = makeMsg(text, [{ type: 'mention', offset: 0, length: 6 }]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('how are you?');
  });

  it('mention match is case-insensitive', () => {
    const text = 'hey @mybot what time is it';
    const msg = makeMsg(text, [{ type: 'mention', offset: 4, length: 6 }]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('hey  what time is it'.trim());
  });

  it('strips a leading bot_command but keeps mid-message commands intact', () => {
    const text = '/about please';
    const msg = makeMsg(text, [{ type: 'bot_command', offset: 0, length: 6 }]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('please');
  });

  it('keeps a bot_command that is not at offset 0 (likely content)', () => {
    // Imagine user pastes "see /docs" inside a question.
    const text = 'see /docs section';
    const msg = makeMsg(text, [{ type: 'bot_command', offset: 4, length: 5 }]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe(text);
  });

  it('handles multiple entities (mention + command) without offset drift', () => {
    const text = '/about @MyBot what is gonka?';
    const msg = makeMsg(text, [
      { type: 'bot_command', offset: 0, length: 6 },
      { type: 'mention', offset: 7, length: 6 },
    ]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('what is gonka?');
  });

  it('returns empty string when the message is only a mention', () => {
    const text = '@MyBot';
    const msg = makeMsg(text, [{ type: 'mention', offset: 0, length: 6 }]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('');
  });

  it('returns the raw text when no entities are present', () => {
    const msg = makeMsg('plain text');
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('plain text');
  });

  it('survives Unicode in surrounding text', () => {
    const text = 'Привет @MyBot 😊';
    const msg = makeMsg(text, [{ type: 'mention', offset: 7, length: 6 }]);
    expect(extractTextWithoutMention(msg, 'MyBot')).toBe('Привет  😊'.trim());
  });
});
